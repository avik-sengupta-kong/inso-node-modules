/** ******************************************************* {COPYRIGHT-TOP} ***
 * Licensed Materials - Property of IBM
 * 5725-Z22, 5725-Z63, 5725-U33, 5725-Z63
 *
 * (C) Copyright IBM Corporation 2016, 2020
 *
 * All Rights Reserved.
 * US Government Users Restricted Rights - Use, duplication or disclosure
 * restricted by GSA ADP Schedule Contract with IBM Corp.
 ********************************************************** {COPYRIGHT-END} **/

'use strict';

const u = require('../lib/utils.js');
const copts = require('../lib/createOptions.js');
const parse = require('../lib/parse.js');
const postParse = require('../lib/postParse.js');
const dictionary = require('../lib/dictionary.js');
const genSOAP = require('../lib/generateSOAP.js');
const genX = require('../lib/generateHTTPXML.js');
const genDefs = require('../lib/generateDefs.js');
const postGen = require('../lib/postGenerate.js');
const example = require('../lib/generateExamples.js');
const rest = require('../lib/createRESTfromSOAP.js');
const R = require('../lib/report.js');

var _ = require('lodash');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');

/**
* Convenience Method for v6
* @param {FileEntry} wsdlEntry - from findWSDLForServiceName
* @param {String} serviceName - Process the indicated service
* @param {String} wsdlId - often the filename
* @param {Object} createOptions
* @return {Object} swagger
*/
function generateSwaggerForWsdlProxy(wsdlEntry, serviceName, wsdlId, createOptions) {
    createOptions = copts.validate(createOptions);
    let openapi = getSwaggerForService(wsdlEntry, serviceName, wsdlId, createOptions);
    if (createOptions.defaults) {
        let defaults = u.deepClone(createOptions.defaults);
        // mergeWith is not available in lodash^3.10
        // so do a merge and assign
        // _.mergeWith(openapi, defaults, customizer);
        _.merge(openapi, defaults);
        if (defaults.securityDefinitions) {
            openapi.securityDefinitions = defaults.securityDefinitions;
        }
        if (defaults.security) {
            openapi.security = defaults.security;
        }
    }
    return openapi;
}

/**
* Convenience Method for v6
* @param {FileEntry} wsdlEntry - from findWSDLForServiceName
* @param {String} serviceName - Process the indicated service
* @param {String} wsdlId - often the filename
* @param {Object} createOptions
* @return {Object} swagger
*/
function generateSwaggerForSoapToRest(wsdlEntry, serviceName, wsdlId, createOptions) {
    createOptions = copts.validate(createOptions);
    let openapi_soap = getSwaggerForService(wsdlEntry, serviceName, wsdlId, createOptions);

    // Create a SOAP->REST api.
    //  - embeds the openapi_soap as a target
    //  - creates rest paths/operations that match the soap operations
    //  - creates an assembly operation-switch which maps the REST api to the soap proxy
    let openapi_rest = rest.getSwaggerForSOAPREST(openapi_soap, createOptions);
    if (createOptions.defaults) {
        let defaults = u.deepClone(createOptions.defaults);
        // mergeWith is not available in lodash^3.10
        // so do a merge and assign
        // _.mergeWith(openapi_rest, defaults, customizer);
        _.merge(openapi_rest, defaults);
        if (defaults.securityDefinitions) {
            openapi_rest.securityDefinitions = defaults.securityDefinitions;
        }
        if (defaults.security) {
            openapi_rest.security = defaults.security;
        }
    }
    return openapi_rest;
}

/**
 * Get the Swagger for the service
 * @method getSwaggerForService
 * @param {FileEntry} wsdlEntry - from findWSDLForServiceName
 * @param {String} serviceName - Process the indicated service
 * @param {String} wsdlId
 * @param {Object} createOptions
 * @return {Object} swagger
 **/
function getSwaggerForService(wsdlEntry, serviceName, wsdlId, createOptions) {
    createOptions = copts.create(createOptions);
    if (typeof wsdlId == 'undefined') {
        wsdlId = 'undefined';
    }
    let req = createOptions.req;
    R.start(req, 'generate');


    if (wsdlEntry == null) {
        // This will occur if findWSDLForServiceName did not find any wsdlEntry objects for serviceName
        // Throw an error that will be useful for the customer.
        throw g.http(u.r(req)).Error('A wsdl \'service\' named "%s" was not found in the wsdl. Please specify a \'service\' that is present in the wsdl. ' +
           'You may need to change the \'title\' of your api to match the name of a \'service\' in the wsdl file.', serviceName);
    }

    // The wsldEntry contains the preparsed and merged information from node soap (see parse.js for details)

    let wsdlJson = wsdlEntry.json;
    let globalNamespaces = wsdlEntry.namespaces;
    let wsdlDefNamespaces = u.deepClone(wsdlEntry.namespaces);

    let schemaList = [];
    if (wsdlJson.definitions.types && wsdlJson.definitions.types.schema) {
        schemaList = u.makeSureItsAnArray(wsdlJson.definitions.types.schema);
    }
    let tns = '';
    if (wsdlJson.definitions['undefined'] && wsdlJson.definitions['undefined'].targetNamespace) {
        tns = wsdlJson.definitions['undefined'].targetNamespace;
    } else if (createOptions.apiFromXSD) {
        tns = 'na';
    }

    R.start(req, 'dictionary');
    // Build a dictionary.
    // Each schema type, element or attribute has an nsName, which is its dictionary index.
    // The node soap object, qualification, and namespace information is stored and is accessible
    // from the dictionary.  For example dict.dictEntry[nsName].schema is the node soap object.
    // A side effect of this call is additional mappings are added to globalNamespaces.
    let dict = dictionary.buildDictionary(schemaList, postParse.isWSAddressing(wsdlJson), globalNamespaces, tns, req);
    schemaList = [];
    dict.createOptions = createOptions;
    R.end(req, 'dictionary');


    // Now start the generation of the Open API (Swagger) document by generating the SOAP/WSDL
    // information.  While processing a refMap is produced which records the references to the
    // objects in the dictionary
    let refMap = {};
    R.start(req, 'generateSOAP');
    let swagger = createOptions.apiFromXSD ?
        genX.generateHTTPXML(serviceName, globalNamespaces, wsdlEntry.serviceJSON, dict, refMap, createOptions) :
        genSOAP.generateSOAP(serviceName, wsdlId, wsdlJson, wsdlDefNamespaces, globalNamespaces, wsdlEntry.serviceJSON, dict, refMap, createOptions);
    u.checkGateway(swagger, createOptions.req);
    if (createOptions.gateway === 'datapower-api-gateway') {
        swagger = u.portToV6Gateway(swagger, createOptions.req);
    }
    wsdlEntry = null;
    wsdlJson = null;
    R.end(req, 'generateSOAP');

    R.start(req, 'generateDefinitions');
    // Add special references for implicit headers
    addXSDElementReferences(refMap, dict);
    if (createOptions.fromGetDefinitionsForXSD) {
        if (swagger.definitions['Security']) {
            delete swagger.definitions['Security'];
        }
    }
    // Add a reference to everything in the dicionary
    if (createOptions.generateAll || createOptions.apiFromXSD) {
        for (let nsName in dict.dictEntry) {
            if (dict.dictEntry[nsName].for !== 'predefined') {
                genDefs.addReference(refMap, nsName, {});
            }
        }
    }

    // Now generate the definitions for each of the references in the refMap
    let totalRefMap = u.deepClone(refMap);
    genDefs.generateSwaggerDefinitions(swagger.definitions, refMap, dict, globalNamespaces, {}, totalRefMap);

    // Clear maps to save space
    refMap = undefined;
    totalRefMap = undefined;

    // The path information generated during generateSOAP is incomplete and requires
    // patching after the swagger definitions are generated.
    genSOAP.patchPaths(swagger, dict);

    // Add friendly definitions for header insertion
    addHeaderDefinitionsForXSD(swagger, dict);
    R.end(req, 'generateDefinitions');
    R.start(req, 'postGenerate1');

    // Do a check for invalid cycles
    for (let nsName in swagger.definitions) {
        u.getAncestorRefs(swagger.definitions, nsName, req);
    }

    let pathCount = swagger.paths ? Object.keys(swagger.paths).length : 0;
    if (pathCount > createOptions.limits.maxOperations) {
        throw g.http(u.r(req)).Error('A wsdl \'service\' named "%s" is too large. ' +
        'The number of wsdl operations %s exceeds the limit of %s.', serviceName, pathCount, createOptions.limits.maxOperations);
    }
    let keyCount = u.countKeys(swagger, true);
    if (keyCount > createOptions.limits.maxIntermediateKeys) {
        throw g.http(u.r(req)).Error('A wsdl \'service\' named "%s" is too large. ' +
        'The number of keys in the api (prior to optimization) %s exceeds the limit of %s.', serviceName, keyCount, createOptions.limits.maxIntermediateKeys);
    }

    R.start(req, 'addXML');
    // Add xml objects to all xso objects in case some were not produced.
    postGen.c14nXMLObjects(swagger);
    R.end(req, 'addXML');

    R.start(req, 'expandTypeOfs');
    postGen.expandTypeOfs(swagger, dict, req);
    R.end(req, 'expandTypeOfs');

    R.start(req, 'inlineAttrs');

    // The UI doesn't support $ref for attributes because it doesn't
    // follow the $ref to see if it is an attribute.  So inline the
    // attributes.
    if (createOptions.inlineAttributes) {
        postGen.inlineSwaggerAttributes(swagger);
    }
    R.end(req, 'inlineAttrs');

    // Remove Occurence Arrays of sequence, group, all and choice
    postGen.removeUnnamedOccurrence(swagger, req);

    // Remove anyOfs
    if (!createOptions.v3anyOf) {
        postGen.removeAnyOfs(swagger, req);
    }

    // Remove removeOneOfs for choice mapping
    if (!createOptions.v3oneOf) {
        postGen.removeOneOfs(swagger);
    }

    // Squash allOf
    postGen.squashAllOfs(swagger);

    // Reprocess complexContent + restriction
    postGen.processComplexContentRestriction(swagger);
    R.end(req, 'postGenerate1');

    R.start(req, 'postGeneratePoly');
    // If a non-default reference is made to a portion of a polymorhic hierarchy,
    // then the entire polymorphic hierarchy must be reproduced with the reference.
    if (!createOptions.v3discriminator) {
        postGen.duplicatePolyHierarchy(swagger, dict);
    }
    dict = {}; // don't need dictionary anymore

    R.end(req, 'postGeneratePoly');

    R.start(req, 'postGenerate3');

    // Make sure default values match the type of the object
    postGen.adjustDefaults(swagger);

    // The algorithms to add definitions may result in unreferenced definitions.
    // These can be removed.
    if (!createOptions.generateAll && !createOptions.apiFromXSD) {
        postGen.removeUnreferencedDefinitions(swagger, createOptions.fromGetDefinitionsForXSD);
    }

    // A type is normally only referenced with either nillable=true or nillable=false.
    // Though uncommon, we could have a situation where a type is referenced sometimes
    // with nillable=true and sometimes with nillable=false.  In those circumstances
    // we must duplicate the definitions (so that we have one for nill and one for not nill)
    // and patch the references.
    postGen.fixupForNilAndNonNil(swagger, createOptions);

    // Remove redundant prefixes
    swagger = postGen.removeRedundantPrefixes(swagger);
    R.end(req, 'postGenerate3');
    R.start(req, 'postGenerateExamples');
    // now generate the example XML for all required types
    if (!createOptions.suppressExamples) {
        try {
            example.generateExamples(swagger, req);
        } catch (e) {
            R.error(req, g.http(u.r(req)).f('An unexpected error (%s) occurred) while generating examples.', e));
        }
    }
    R.end(req, 'postGenerateExamples');

    dict = {};

    // Add xml objects to all xso objects in case some were not produced.
    R.start(req, 'postGenerateFinal');

    swagger = postGen.cleanupDefinitions(swagger);

    // Another pass for removing unref'd definitions
    if (!createOptions.generateAll && !createOptions.apiFromXSD) {
        postGen.removeUnreferencedDefinitions(swagger, createOptions.fromGetDefinitionsForXSD);
    }

    postGen.c14nXMLObjects(swagger, true);
    postGen.c14nxso(swagger, req, createOptions.v3nullable);

    // Due to a bug in the mapping runtime, allOf lengths at the root level must be less than 3
    u.shortenAllOfs(swagger);
    R.end(req, 'postGenerateFinal');

    R.start(req, 'checkAndFix');
    swagger = u.checkAndFix(swagger);
    R.end(req, 'checkAndFix');
    R.end(req, 'generate');

    moveMessages(swagger, req);
    copts.persistOptions(createOptions, swagger);
    let messages = R.getMessages(req, createOptions.level);
    if (messages) {
        swagger['x-ibm-configuration']['x-ibm-apiconnect-wsdl'].messages = messages;
    }

    return swagger;
}

/**
* Add XSD Element references for implicit headers
*/
function addXSDElementReferences(refMap, dict) {
    // Walk all of the root elements in the dictEntry.
    for (let nsName in dict.dictEntry) {
        let dictEntry = dict.dictEntry[nsName];

        // Only process elements that are marked as implicit headers
        if (dictEntry.for !== 'element') {
            continue;
        }
        if (!dict.createOptions.fromGetDefinitionsForXSD && !dictEntry.tagInfo.forImplicitHeader) {
            continue;
        }
        // Get the original name of the element (not the mangled definition name)
        let originalName = dictEntry.tagInfo.name;

        // If the name is in the list (or there is no list), then process it
        if ((!dict.createOptions.rootElementList || dict.createOptions.rootElementList.length == 0) ||
            dict.createOptions.rootElementList.indexOf(originalName) > -1 ||
            dict.createOptions.rootElementList.indexOf(nsName) > -1) {

            // Add the xmlName to the reference
            genDefs.addReference(refMap, nsName, {
                xmlName: originalName
            });

            // Find and add a reference to the type
            if (dict.dictEntry[nsName] &&
                dict.dictEntry[nsName].typeNSName) {
                genDefs.addReference(refMap,
                  dict.dictEntry[nsName].typeNSName,
                  {});
            }
        }
    }
}

/**
* add friendly header definitions that wrap the element
*/
function addHeaderDefinitionsForXSD(swagger, dict) {
    // Walk all of the root elements.
    for (let nsName in dict.dictEntry) {
        let dictEntry = dict.dictEntry[nsName];
        if (dictEntry.for !== 'element') {
            continue;
        }
        if (!dict.createOptions.fromGetDefinitionsForXSD && !dictEntry.tagInfo.forImplicitHeader) {
            continue;
        }
        if (dictEntry.tagInfo) {
            let elementNSName = nsName + '_of_' + dictEntry.tagInfo.name;
            if (swagger.definitions[elementNSName]) {
                // Get the original name of the element (not the mangled definition name)
                let origElementName = swagger.definitions[elementNSName].xml.name;
                let headerNsName = nsName + '_Header';
                swagger.definitions[headerNsName] = {};
                swagger.definitions[headerNsName].xml = {};

                swagger.definitions[headerNsName].xml.namespace = swagger.definitions[elementNSName].xml.namespace;
                swagger.definitions[headerNsName].xml.prefix = swagger.definitions[elementNSName].xml.prefix;
                swagger.definitions[headerNsName].type = 'object';
                swagger.definitions[headerNsName].properties = {};
                swagger.definitions[headerNsName].properties[origElementName] = {};
                swagger.definitions[headerNsName].properties[origElementName]['$ref'] = '#/definitions/' + elementNSName;
            }
        }
    }
}

/**
* moveMessages
* All messages were applied as description text inside the definitions are reported
* @param swagger
* @param req
*/
function moveMessages(swagger, req) {
    u.traverse(swagger, null, function(obj, path) {
        if (obj && typeof obj === 'object') {
            let apic = obj['x-ibm-messages'];
            if (apic) {
                for (let i = 0; i < apic.info.length; i++) {
                    let ref = '#/' + _.join(path, '/');
                    let key =  apic.info[i] + ' ' + ref;
                    R.info(req, key, apic.info[i], ref);
                }
                for (let i = 0; i < apic.warning.length; i++) {
                    let ref = '#/' + _.join(path, '/');
                    let key =  apic.warning[i] + ' ' + ref;
                    R.info(req, key, apic.warning[i], ref);
                }
                for (let i = 0; i < apic.error.length; i++) {
                    let ref = '#/' + _.join(path, '/');
                    let key =  apic.error[i] + ' ' + ref;
                    R.info(req, key, apic.error[i], ref);
                }
                delete obj['x-ibm-messages'];
            }
        }
        return obj;
    });
}

exports.generateSwaggerForSoapToRest = generateSwaggerForSoapToRest;
exports.generateSwaggerForWsdlProxy = generateSwaggerForWsdlProxy;
exports.getSwaggerForService = getSwaggerForService;
