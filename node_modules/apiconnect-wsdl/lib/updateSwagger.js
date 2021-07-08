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
var _ = require('lodash');
/**
* Update functions for the apiconnect-wsdl parser
**/

const u = require('../lib/utils.js');
const wsdl = require('../src/wsdl.js');
const parse = require('../lib/parse.js');
const openApiV3 = require('../lib/openApiV3.js');
const copts = require('../lib/createOptions.js');
const a = require('../lib/api.js');

const jsyaml = require('js-yaml');
const fs = require('fs');
const q = require('q');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');

/**
* Return promise with new swagger that is the original openApi
* ammended with new service swaggers sourced from wsdl
* @param api
* @param wsdl is wsdl location or content (Buffer or String)
* @param serviceName is the service being replaced
* @return Promise with new open api
*/
async function updateOpenApiFromWSDL(api, wsdl, serviceName, options) {
    options = copts.create(options);
    let req = options.req;

    if ((typeof api) === 'string') {
        api = jsyaml.safeLoad(fs.readFileSync(api, 'utf8'));
    }

    // Get the services from the WSDL and make sure the indicated service is found
    let serviceData = await a.introspectWSDL(wsdl, options);
    // Find service in WSDL
    let service;
    if (serviceData.services) {
        for (let i = 0; i < serviceData.services.length; i++) {
            if (serviceData.services[i].service  == serviceName) {
                service = serviceData.services[i];
                break;
            }
        }
    }
    if (!service) {
        throw g.http(u.r(req)).Error('The service, %s, was not found in the WSDL.', serviceName);
    }

    // Find matching section in api
    let section, sectionName;
    if (api['x-ibm-configuration'] &&
        api['x-ibm-configuration']['wsdl-definition'] &&
        api['x-ibm-configuration']['wsdl-definition'].service == serviceName) {
        section = api;
    }
    if (!section &&
        api['x-ibm-configuration'] &&
        api['x-ibm-configuration'].targets) {
        for (let targetName in api['x-ibm-configuration'].targets) {
            let t = api['x-ibm-configuration'].targets[targetName];
            if (t['x-ibm-configuration'] &&
                t['x-ibm-configuration']['wsdl-definition'] &&
                t['x-ibm-configuration']['wsdl-definition'].service == serviceName) {
                section = t;
                sectionName = targetName;
                break;
            }
        }
    }
    if (!section) {
        throw g.http(u.r(req)).Error('The service, %s, was not found in the api.', serviceName);
    }

    // Create new api from the WSDL
    let createOptions = {};
    if (section['x-ibm-configuration'] &&
        section['x-ibm-configuration']['x-ibm-apiconnect-wsdl'] &&
        section['x-ibm-configuration']['x-ibm-apiconnect-wsdl'].options) {
        createOptions = u.deepClone(section['x-ibm-configuration']['x-ibm-apiconnect-wsdl'].options);
    }
    createOptions.openapiVersion = section.swagger || section.openapi;
    createOptions.type = section['x-ibm-configuration'].type;
    let wsdlId = section['x-ibm-configuration']['wsdl-definition'].wsdl;
    let result = await a.createOpenApi(wsdl, serviceName, wsdlId, createOptions);
    // Now update the appropriate sections and return
    let updatedAPI = u.deepClone(api);
    updatedAPI =  updateSection(api, sectionName, result.openapi, null, updatedAPI);
    if (createOptions.type === 'wsdl-to-rest') {
        // If wsdl-to-rest, also update the target and the assembly
        updatedAPI =  updateSection(api, serviceName, result.openapi, serviceName, updatedAPI);
        updatedAPI['x-ibm-configuration'].assembly = result.openapi['x-ibm-configuration'].assembly;
    }
    fixupAssembly(updatedAPI);
    return updatedAPI;
}

/**
* Return new swagger that is the originalSwagger
* ammended with new service swaggers sourced from allWSDLs
*/
function updateSwaggerFromWSDL(originalSwagger, allWSDLs, wsdlId, options) {
    options = options || {};

    if ((typeof originalSwagger) === 'string') {
        originalSwagger = jsyaml.safeLoad(fs.readFileSync(originalSwagger, 'utf8'));
    }
    let swaggers = getSwaggers(originalSwagger, allWSDLs, wsdlId, options);

    // Update the original swagger
    var swagger = originalSwagger;
    for (var j = 0; j < swaggers.length; j++) {
        swagger = updateOpenApi(swagger, swaggers[j], wsdlId, false, options);
    }
    return swagger;
}

/**
* @return a list of swaggers for each service in allWSDLs
*/
function getSwaggers(originalSwagger, allWSDLs, wsdlId, options) {
    options = options || {};
    let req = options.req;
    // Get wsdl service names from the original swagger
    var sp = {};
    if (originalSwagger['x-ibm-configuration'] &&
        originalSwagger['x-ibm-configuration']['wsdl-definition'] &&
        originalSwagger['x-ibm-configuration']['wsdl-definition'].service) {
        let s = originalSwagger['x-ibm-configuration']['wsdl-definition'].service;
        let p = originalSwagger['x-ibm-configuration']['wsdl-definition'].port;
        let copts;
        if (originalSwagger['x-ibm-configuration']['x-ibm-apiconnect-wsdl']) {
            copts = originalSwagger['x-ibm-configuration']['x-ibm-apiconnect-wsdl'].options;
        }
        sp[s + ':' + p] = {
            service: s,
            port: p,
            copts: copts
        };
    }

    if (originalSwagger['x-ibm-configuration'] &&
        originalSwagger['x-ibm-configuration'].targets) {
        for (var t in originalSwagger['x-ibm-configuration'].targets) {
            var target = originalSwagger['x-ibm-configuration'].targets[t];
            if (target['x-ibm-configuration'] &&
                target['x-ibm-configuration']['wsdl-definition'] &&
                target['x-ibm-configuration']['wsdl-definition'].service) {
                let s = target['x-ibm-configuration']['wsdl-definition'].service;
                let p = target['x-ibm-configuration']['wsdl-definition'].port;
                let copts;
                if (target['x-ibm-configuration']['x-ibm-apiconnect-wsdl']) {
                    copts = target['x-ibm-configuration']['x-ibm-apiconnect-wsdl'].options;
                }
                sp[s + ':' + p] = {
                    service: s,
                    port: p,
                    copts: copts
                };
            }
        }
    }

    // Get all of the services
    var serviceData = parse.getWSDLServicesAll(allWSDLs, options);
    var swaggers = [];
    let wsdlSP = [];
    // Create swaggers for matching services
    if (serviceData && serviceData.services) {
        for (let i = 0; i < serviceData.services.length; i++) {
            let sd = serviceData.services[i];
            let s = sd.service;
            let portNames = [ sd.portName ];
            if (sd.ports) {
                portNames = _.concat(Object.keys(sd.ports), sd.portName);
            }
            for (let j = 0; j < portNames.length; j++) {
                let p = portNames[j];
                wsdlSP = wsdlSP.concat(s + ':' + p);
                if (sp[s + ':' + p]) {
                    let wsdlEntry = wsdl.findWSDLForServiceName(allWSDLs, sd.service);
                    let createOptions = sp[s + ':' + p].copts || {};
                    swaggers.push(wsdl.getSwaggerForService(wsdlEntry, sd.service, wsdlId, createOptions));
                }
            }
        }
    }

    // If no swaggers found, throw an error
    if (swaggers.length === 0) {
        throw g.http(u.r(req)).Error('The wsdl contains the following wsdl services and ports %s' +
         '. The api does not reference any of these service and port combinations.' +
         ' Provide a new wsdl file or change the api\'s \'wsdl-definition.service\' and \'wsdl-definition.port\' fields.', wsdlSP);
    }

    return swaggers;
}

/**
 * Return new swagger that is the original swagger (swagger1)
 * ammended with api information from a new swagger (swagger2)
 * @return updated swagger
 */
function updateOpenApi(swagger1, swagger2, wsdlId, verbose, options) {
    options = options || {};
    let req = options.req;

    if ((typeof swagger1) === 'string') {
        swagger1 = jsyaml.safeLoad(fs.readFileSync(swagger1, 'utf8'));
    }
    if ((typeof swagger2) === 'string') {
        swagger2 = jsyaml.safeLoad(fs.readFileSync(swagger2, 'utf8'));
    }

    let version1 = swagger1.swagger || swagger1.openapi;
    let version2 = swagger2.swagger || swagger2.openapi;
    if (version1 != version2) {
        throw g.http(u.r(req)).Error('Different versions of open api detected, %s and %s.', version1, version2);
    }

    // Create swagger3 (result swagger) from the original swagger.
    // We want to keep most of the information.
    var swagger3 = u.deepClone(swagger1);

    // Update the root api (paths)
    // Find the service (if specified) for the orignal swagger
    var service = null;
    if (swagger1['x-ibm-configuration'] && swagger1['x-ibm-configuration']['wsdl-definition']) {
        service = swagger1['x-ibm-configuration']['wsdl-definition'].service;
        if (verbose) {
            console.log('Original yaml: Found public wsdl service: ' + service);
        }
    } else if (verbose) {
        console.log('Original yaml: No public wsdl service');
    }

    if (!service) {
        // No service found, update root information with new yaml if new yaml does not have a service either
        if (!swagger2['x-ibm-configuration'] ||
            !swagger2['x-ibm-configuration']['wsdl-definition']) {
            if (verbose) {
                console.log('New yaml: No public wsdl service');
                console.log('UPDATE: new yaml [public] -> updated yaml [public]');
            }
            updateSection(swagger1, null, swagger2, null, swagger3);
        } else {
            // No changes
        }
    } else if (swagger2['x-ibm-configuration'] &&
               swagger2['x-ibm-configuration']['wsdl-definition'] &&
               swagger2['x-ibm-configuration']['wsdl-definition'].service == service) {
        if (verbose) {
            console.log('New yaml: Found public wsdl service: ' + service);
            console.log('UPDATE: new yaml [public] -> updated yaml [public]');
        }
        updateSection(swagger1, null, swagger2, null, swagger3);

        // If wsdlId is set, then also update the public wsdl to the wsdlId
        if (wsdlId) {
            swagger3['x-ibm-configuration']['wsdl-definition'].wsdl = wsdlId;
        }

    } else if (swagger2['x-ibm-configuration'].targets) {
        for (var targetName in swagger2['x-ibm-configuration'].targets) {
            if (swagger2['x-ibm-configuration'].targets[targetName]['wsdl-definition'] &&
                swagger2['x-ibm-configuration'].targets[targetName]['wsdl-definition'].service == service) {
                if (verbose) {
                    console.log('New yaml: Found implentation wsdl service: ' + service + ' in target ' + targetName);
                    console.log('UPDATE: new yaml [' + targetName + '] -> updated yaml [public]');
                }
                updateSection(swagger1, null, swagger2, targetName, swagger3);
            }
        }
    }

    // Now update any embedded implementation target services
    if (swagger1['x-ibm-configuration'].targets) {
    // For each implementation service in the original, find and update with a matching service from the new yaml
        for (var targetName1 in swagger1['x-ibm-configuration'].targets) {
            service = null;
            var target1 = swagger1['x-ibm-configuration'].targets[targetName1];
            if (target1['x-ibm-configuration'] && target1['x-ibm-configuration']['wsdl-definition']) {
                service = target1['x-ibm-configuration']['wsdl-definition'].service;
                if (verbose) {
                    console.log('Original yaml: Found implementation service in original yaml: ' + service + ' within target ' + targetName1);
                }
            }
            if (service) {
                if (swagger2['x-ibm-configuration'] &&
                    swagger2['x-ibm-configuration']['wsdl-definition'] &&
                    swagger2['x-ibm-configuration']['wsdl-definition'].service == service) {
                    if (verbose) {
                        console.log('New yaml: Found public wsdl service: ' + service);
                        console.log('UPDATE: new yaml [public] -> updated yaml [' + targetName1 + ']');
                    }
                    updateSection(swagger1, targetName1, swagger2, null, swagger3);
                } else if (swagger2['x-ibm-configuration'].targets) {
                    for (var targetName2 in swagger2['x-ibm-configuration'].targets) {
                        if (swagger2['x-ibm-configuration'].targets[targetName2]['wsdl-definition'] &&
                            swagger2['x-ibm-configuration'].targets[targetName2]['wsdl-definition'].service == service) {
                            if (verbose) {
                                console.log('New yaml: Found implementation service in original yaml: ' + service + ' within target ' + targetName2);
                                console.log('UPDATE: new yaml [' + targetName2 + '] -> updated yaml [' + targetName1 + ']');
                            }
                            updateSection(swagger1, targetName1, swagger2, targetName2, swagger3);
                        }
                    }
                }
            }
        }
    }

    fixupAssembly(swagger3);

    return swagger3;
}

/**
 * Return new swagger that is the original swagger (swagger1)
 * ammended with a new swagger (swagger2) from a wsdl or upload
 */
function updateSection(swagger1, section1, swagger2, section2, outSwagger) {

    let swagger3 = outSwagger;
    if (section1) {
        swagger1 = swagger1['x-ibm-configuration'].targets[section1];
        swagger3 = swagger3['x-ibm-configuration'].targets[section1];
    }

    if (section2) {
        swagger2 = swagger2['x-ibm-configuration'].targets[section2];
    }

    // Update x-ibm-apiconnect-wsdl
    if (swagger2['x-ibm-configuration'] &&
        swagger2['x-ibm-configuration']['x-ibm-apiconnect-wsdl']) {
        swagger3['x-ibm-configuration']['x-ibm-apiconnect-wsdl'] =
          swagger2['x-ibm-configuration']['x-ibm-apiconnect-wsdl'];
    }

    // Analyze paths
    for (var pathName in swagger1.paths) {
        if (!swagger2.paths[pathName]) {
            delete swagger3.paths[pathName]; // Delete paths not in the new swagger
        } else {
            updatePath(swagger3.paths[pathName], swagger2.paths[pathName]);
            swagger3.paths[pathName] = updateRefs(swagger3.paths[pathName], section1, section2);
        }
    }

    // Copy new paths to swagger3
    for (pathName in swagger2.paths) {
        if (!swagger3.paths[pathName]) {
            swagger3.paths[pathName] = u.deepClone(swagger2.paths[pathName]);
            swagger3.paths[pathName] = updateRefs(swagger3.paths[pathName], section1, section2);
        }
    }

    // Get the definitions or components/schemas object
    let s1 = definitionsOrSchemas(swagger1);
    let s2 = definitionsOrSchemas(swagger2);
    let s3 = definitionsOrSchemas(swagger3);
    for (var defName in s1) {
        if (!s2[defName]) {
            delete s3[defName]; // Delete definitions not in the new wsdl...we don't know if the user added these or not
        } else {
            s3[defName] = u.deepClone(s2[defName]);
            s3[defName] = updateRefs(s3[defName], section1, section2);
        }
    }

    for (defName in s2) {
        if (!s3[defName]) {
            s3[defName] = u.deepClone(s2[defName]);
            s3[defName] = updateRefs(s3[defName], section1, section2);
        }
    }

    // Respect Security setting in Headers
    for (defName in s3) {
        if (defName.endsWith('Header') && s1[defName]) {
            if (!s1[defName].properties ||
                !s1[defName].properties.Security) {
                if (s3[defName].properties &&
                    s3[defName].properties.Security) {
                    delete s3[defName].properties.Security;
                }
            }
        }
    }

    // Respect order from s2
    let ordered = {};
    for (defName in s2) {
        if (s3[defName]) {
            ordered[defName] = s3[defName];
        }
    }
    for (defName in s3) {
        if (!ordered[defName]) {
            ordered[defName] = s3[defName];
        }
    }
    if (swagger3.openapi) {
        swagger3.components.schemas = ordered;
    } else {
        swagger3.definitions = ordered;
    }
    return outSwagger;
}

function updatePath(path3, path2) {
    for (var methodName in path3) {
        if (!path2[methodName]) {
            delete path3[methodName]; // Delete methods not in the new wsdl
        }
    }

    for (methodName in path2) {
        if (path3[methodName]) {
            // Replace the method with the new one.
            // Preserve the operationId and summary because these are auto-gen'd and updated by customer in many cases
            var operationId = path3[methodName].operationId;
            var summary = path3[methodName].summary;
            path3[methodName] = u.deepClone(path2[methodName]);
            if (operationId) {
                path3[methodName].operationId = operationId;
            }
            if (summary) {
                path3[methodName].summary = summary;
            }
            // what about headers and non-soap parameters ?
        } else {
            path3[methodName] = u.deepClone(path2[methodName]);
        }
    }
    return;
}

function updateRefs(json, section1, section2) {
    if (section1 == section2) {
        return json;
    }

    let jsonString = JSON.stringify(json);
    let source1 = section2 ? '#/x-ibm-configuration/targets/' + section2 + '/definitions/' : '#/definitions/';
    let target1 = section1 ? '#/x-ibm-configuration/targets/' + section1 + '/definitions/' : '#/definitions/';
    let source2 = section2 ? '#/x-ibm-configuration/targets/' + section2 + '/components/schemas/' : '#/components/schemas/';
    let target2 = section1 ? '#/x-ibm-configuration/targets/' + section1 + '/components/schemas/' : '#/components/schemas/';


    jsonString = jsonString.replace(new RegExp(source1, 'g'), target1);
    jsonString = jsonString.replace(new RegExp(source2, 'g'), target2);
    return JSON.parse(jsonString);
}

/**
* @returns definitions (V2) or components.schemas (V3)
*/
function definitionsOrSchemas(swagger) {
    if (swagger.openapi) {
        return swagger.components ? swagger.components.schemas : null;
    }
    return swagger.definitions;
}

/**
* @param The new updated swagger.
* traverse the x-ibm-configuration and fixup any refs that are not found.
*/
function fixupAssembly(swagger) {
    let swaggers = [];
    u.traverseSwagger(swagger, function(swagger) {
        swaggers.push(swagger);
        return swagger;
    });
    u.traverse(swagger['x-ibm-configuration']['assembly'], function(curr, path, stack) {
        let key = path.length > 0 ? path[path.length - 1] : undefined;
        if (key == '$ref') {
            let xso = getRef(swagger, curr);
            if (!xso) {
                let i = curr.lastIndexOf('/');
                let definitionsPath = curr.substring(0, i);
                let swaggerPath = definitionsPath.substring(0, definitionsPath.lastIndexOf('/'));
                let s = getRef(swagger, swaggerPath);
                let oldNSName = curr.substring(i + 1);
                let newNSName = u.oldNSName2newNSName(oldNSName, s);
                if (newNSName) {
                    curr = definitionsPath + '/' + newNSName;
                }
            }
        } else if (key == 'actions' && Array.isArray(curr)) {
            for (let i = 0; i < curr.length; i++) {
                let action = curr[i];
                if (action.set.endsWith('x-ibm-discriminator') && action.default) {
                    for (let j = 0; j < swaggers.length; j++) {
                        let newNSName = u.oldNSName2newNSName(action.default, swaggers[j]);
                        if (newNSName) {
                            action.default = newNSName;
                            break;
                        }
                    }
                }
            }
        }
        return curr;
    });
}

function getRef(swagger, ref) {
    let keys = ref.split('/');
    let def = swagger;
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== '#') {
            def = def[keys[i]];
            if (!def) {
                return null;
            }
        }
    }
    return def;
}

exports.updateSwaggerFromWSDL = updateSwaggerFromWSDL;
exports.updateOpenApiFromWSDL = updateOpenApiFromWSDL;
exports.updateOpenApi = updateOpenApi;
