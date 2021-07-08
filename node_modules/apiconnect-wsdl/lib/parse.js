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
const d = require('../lib/domUtils.js');
var _ = require('lodash');
const parseUtils = require('../lib/parseUtils.js');
const fileUtils = require('../lib/fileUtils.js');
const postParse = require('../lib/postParse.js');
const jsyaml = require('js-yaml');
const assert = require('assert');
const XML2JSparseString = require('xml2js').parseString;
const fs = require('fs');

const q = require('q');
const yauzl = require('yauzl');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');
const R = require('../lib/report.js');


/**
* Main entry point for accessing the files and returning the
* parsed content (allWSDLs).
* @param location of wsdl/zip files/urls
* If array item is a String, algorithm assumes a location on file system or url.
* If that fails, the algorithm attempts to create a base64 or binary buffer from the String
* @param auth
* @param options
*   req: request or null (used for i18n negotiation)
*   flatten: dev only
*   allowExtraFiles: default true (legacy behavior)
* @return allWSDLs, which is a array of wsdlEntry object representing
* the parsed information.
*/
async function getJsonForWSDL(location, auth, options) {
    var outArchive, outContent;  // archive (zip) or content (file)
    options = options || {
        allowExtraFiles: true // Allow extra files in zip files...this is the legacy behavior
    };
    let req = options.req;
    let out;
    R.start(req, 'getJsonForWSDL');
    try {
        R.start(req, 'parse');
        out = await parse(location, auth, options);
        outArchive = out.archive;
        outContent = out.content;
        R.end(req, 'parse');
    } catch (err) {
        R.end(req, 'parse', err);
        R.end(req, 'getJsonForWSDL', err);
        throw err;
    }
    try {
        R.start(req, 'merge');
        // Now post process the files and return the allWSDLs array
        let allWSDLs = await postParse.merge(out.files, auth, options);

        // Place the output archive in the first allWSDLs file item.
        if (allWSDLs && allWSDLs.length > 0) {
            allWSDLs[0].archive = outArchive;
            allWSDLs[0].content = outContent;
        }
        R.end(req, 'merge');
        R.end(req, 'getJsonForWSDL');
        return allWSDLs;
    } catch (err) {
        R.end(req, 'merge', err);
        R.end(req, 'getJsonForWSDL', err);
        throw err;
    }
}

/**
* Do some simple checking of the wsdl definition object and return an array of the problems found
*/
function sanityCheckDefinition(definitions, req) {
    let errs = [];
    // Make sure each portType.operation references a defined message
    let portTypes = u.makeSureItsAnArray(definitions.portType);
    let messages = u.makeSureItsAnArray(definitions.message);
    let bindings = u.makeSureItsAnArray(definitions.binding);
    let services = u.makeSureItsAnArray(definitions.service);


    // Make sure each operation references a message
    for (let i = 0; i < portTypes.length; i++) {
        let portType = portTypes[i];
        let operations = u.makeSureItsAnArray(portType.operation);
        for (let j = 0; j < operations.length; j++) {
            let operation = operations[j];
            let opName = operation['undefined'].name;
            let children = [ 'input', 'output', 'fault' ];
            for (let c = 0; c < children.length; c++) {
                let key = children[c];
                if (operation[key] && operation[key]['undefined'] && operation[key]['undefined'].message) {
                    let message = u.stripNamespace(operation[key]['undefined'].message);
                    let found = false;
                    for (let m = 0; m < messages.length  && !found; m++) {
                        if (messages[m]['undefined'] && messages[m]['undefined'].name === message) {
                            found = true;
                        }
                    }
                    if (!found) {
                        errs.push(g.http(u.r(req)).f('Could not find wsdl \'message\' "%s" referenced in wsdl \'operation\' "%s". This is a violation of a WS-I Rule (R2101 A DESCRIPTION MUST NOT use QName references to WSDL components in namespaces that have been neither imported, nor defined in the referring WSDL document).', message, opName));
                    }
                }
            }
        }
    }
    // Make sure every binding operation has a matching portType operation
    for (let i = 0; i < bindings.length; i++) {
        let binding = bindings[i];
        let bindingName = binding['undefined'].name;
        let bOperations = u.makeSureItsAnArray(binding.operation);
        let portTypeName = u.stripNamespace(binding['undefined'].type);
        let portTypeFound = false;
        for (let j = 0; j < portTypes.length; j++) {
            let portType = portTypes[j];
            if (portType['undefined'].name === portTypeName) {
                portTypeFound = true;
                let pOperations = u.makeSureItsAnArray(portType.operation);
                if (pOperations.length !== bOperations.length) {
                    errs.push(g.http(u.r(req)).f('The number of wsdl \'operations\' in \'binding\' "%s" does not match the number of \'operations\' in its \'portType\' "%s".' +
                    ' This is a violation of a WS-I rule (R2718 A wsdl:binding in a DESCRIPTION MUST have the same set of wsdl:operations as the wsdl:portType to which it refers).',
                      bindingName, portTypeName));
                }
                for (let k = 0; k < bOperations.length; k++) {
                    let bOpName = bOperations[k]['undefined'].name;
                    let found = false;
                    for (let l = 0; l < pOperations.length && !found; l++) {
                        let pOpName = pOperations[l]['undefined'].name;
                        if (pOpName === bOpName) {
                            found = true;
                        }
                    }
                    if (!found) {
                        errs.push(g.http(u.r(req)).f('The wsdl \'operation\' "%s" in \'binding\' "%s" does not match any \'operations\' in its \'portType\' "%s".' +
                        ' This is a violation of a WS-I rule (R2718 A wsdl:binding in a DESCRIPTION MUST have the same set of wsdl:operations as the wsdl:portType to which it refers).',
                        bOpName, bindingName, portTypeName));
                    }
                }
            }
        }
        if (!portTypeFound) {
            errs.push(g.http(u.r(req)).f('The portType %s is not found. This is a violation of a WS-I Rule (R2101 A DESCRIPTION MUST NOT use QName references to WSDL components in namespaces that have been neither imported, nor defined in the referring WSDL document).', portTypeName));
        }
    }
    // Make sure the services have bindings
    for (let i = 0; i < services.length; i++) {
        let service = services[i];
        let serviceName = service['undefined'].name;
        let ports = u.makeSureItsAnArray(service.port);
        for (let j = 0; j < ports.length; j++) {
            let port = ports[j];
            let bindingName = u.stripNamespace(port['undefined'].binding);
            let found = false;
            for (let k = 0; k < bindings.length && !found; k++) {
                let binding = bindings[k];
                if (binding['undefined'].name === bindingName) {
                    found = true;
                }
            }
            if (!found) {
                errs.push(g.http(u.r(req)).f('The wsdl \'binding\' "%s" referenced by \'service\' "%s" cannot be found.',
                  bindingName, serviceName));
            }
        }
    }
    return errs;
}


/**
* Get the services from allWSDLs.  Called by 508x
* @param allWSDLs (from getJsonForWSDL)
* @param options
*   req: request or null (used for i18n negotiation)
* @returns data object that contains the names of the services, portTypes, bindings, serviceOperations
*/
function getWSDLServices(allWSDLs, options) {
    let serviceData = getWSDLServicesAll(allWSDLs, options);
    // Remove portName and other fields not needed by 508x
    if (serviceData.services) {
        for (let i = 0; i < serviceData.services.length; i++) {
            delete serviceData.services[i].portName;
            delete serviceData.services[i].bindingName;
            delete serviceData.services[i].endpoint;
            delete serviceData.services[i].ports;
        }
    }
    return serviceData;
}

/**
* Get the services from allWSDLs.  Primarily used by the UI to display the services found
* in the parsed information (allWSDLs) so that the user can choose which service to generate.
* @param allWSDLs (from getJsonForWSDL)
* @param options
*   req: request or null (used for i18n negotiation)
* @returns data object that contains the names of the services, portTypes, bindings, serviceOperations
*/
function getWSDLServicesAll(allWSDLs, options) {
    options = options || {};
    let req = options.req;
    var data = {
        portTypes: {},
        bindings: {},
        services: []
    };

    // If this is a RESTFUL XML service, then there is no WSDL file.
    // Return data for a RESTFUL XML SERVICE
    if (allWSDLs.length >= 1 &&
        allWSDLs[0].serviceJSON &&
        allWSDLs[0].serviceJSON.service &&
        allWSDLs[0].serviceJSON.service.length === 1 &&
        allWSDLs[0].serviceJSON.service[0]['undefined'] &&
        allWSDLs[0].serviceJSON.service[0]['undefined'].endpoint === u.RESTFUL_XML_URL) {
        for (let i = 0; i < allWSDLs.length; i++) {
            data.services.push({
                service: allWSDLs[i].serviceJSON.service[0]['undefined'].name,
                portName: 'port',
                endpoint: u.RESTFUL_XML_URL,
                fileName: allWSDLs[i].fullName,
                operations: [] });
        }
        return data;
    }
    try {
        var wLen = allWSDLs.length;
        var operations, operation, ops;
        var serviceMap = {};
        for (var x = 0; x < wLen; x++) {
            var wsdlJson = allWSDLs[x].json;

            var portTypes = u.makeSureItsAnArray(wsdlJson.definitions.portType);
            var typeLen = portTypes.length;
            for (var i = 0; i < typeLen; i++) {
                let portType = portTypes[i];
                operations = u.makeSureItsAnArray(portType.operation);
                ops = [];
                let len = operations.length;
                let opNames = {};
                for (var p = 0; p < len; p++) {
                    operation = operations[p];
                    let opName = operation['undefined'].name;
                    ops.push({
                        name: opName,
                        description: u.cleanupDocumentation(operation.documentation, req)
                    });
                    if (opNames[opName]) {
                        R.error(req, g.http(u.r(req)).f(
                          'Found multiple operations of the same name %s within portType %s.' +
                          ' This is a violation of a WS-I Rule (R2304 A wsdl:portType in a DESCRIPTION MUST have operations with distinct values for their name attributes).' +
                          ' Processing continues, but problems could occur.',
                          opName, portType.name));
                    }
                    opNames[opName] = operation;
                } // end for
                data.portTypes[portType['undefined'].name] = ops;
            } // end for
            var bindings = u.makeSureItsAnArray(wsdlJson.definitions.binding);
            var binLen = bindings.length;
            for (var j = 0; j < binLen; j++) {
                var binding = bindings[j];
                if (!binding || !binding.binding) {
                    continue;
                }
                let style = binding.binding['undefined'].style;
                var bindingType = binding['undefined'].type;
                bindingType = u.stripNamespace(bindingType);
                operations = u.makeSureItsAnArray(binding.operation);
                ops = [];
                var operLen = operations.length;
                for (var n = 0; n < operLen; n++) {
                    operation = operations[n];
                    ops.push(operation['undefined'].name);
                    let opStyle = operation.operation && operation.operation['undefined'] ? operation.operation['undefined'].style : '';
                    if (!style && opStyle) {
                        // If the style is not set on the binding, but is present on an operation then set the style
                        style = opStyle;
                    } else if (opStyle && (style !== opStyle)) {
                        // Found a mixture of operations, which is a violation
                        R.error(req, g.http(u.r(req)).f(
                         'SOAP Binding %s has a mixture of styles (%s and %s).' +
                         ' This is a violation of a WS-I Rule (R2705 A wsdl:binding in a DESCRIPTION MUST either be a rpc-literal binding or a document-literal binding).' +
                         ' Processing continues, but problems could occur.',
                         binding['undefined'].name, opStyle, style));
                    }
                } // end for
                var bind = {
                    type: bindingType,
                    operations: ops
                };
                // Only store soap bindings
                if (binding.binding && binding.binding['undefined'] &&
                   (binding.binding['undefined'].transport ||
                    binding.binding['undefined'].style == 'document' ||
                    binding.binding['undefined'].style == 'rpc')) {
                    bind.bindingNS = binding.binding['undefined'].__namespace__;
                    data.bindings[binding['undefined'].name] = bind;
                    // Additional checking of the binding
                    if (binding.binding['undefined'].transport !== 'http://schemas.xmlsoap.org/soap/http') {
                        R.warning(req, g.http(u.r(req)).f(
                         'SOAP Binding %s has an invalid transport value (%s).' +
                         ' This is a violation of a WS-I Rule (R2702 When HTTP is used, a wsdl:binding element in a DESCRIPTION MUST specify the HTTP transport protocol with SOAP binding. Specifically, the transport attribute of its wsoap11:binding child MUST have the value "http://schemas.xmlsoap.org/soap/http").' +
                         ' Processing continues, but problems could occur.',
                         binding['undefined'].name, binding.binding['undefined'].transport));
                    }
                }
            } // end for
            // If two bindings reference the same portType and have the same binding namespace,
            // this is probably a mistake. Issue a warning.
            let bindingNames = Object.keys(data.bindings);
            for (let i = 0; i < bindingNames.length; i++) {
                for (let j = i + 1; j < bindingNames.length; j++) {
                    const bind1 = data.bindings[bindingNames[i]];
                    const bind2 = data.bindings[bindingNames[j]];
                    if (bind1.type == bind2.type && bind1.bindingNS == bind2.bindingNS) {
                        R.info(req, g.http(u.r(req)).f(
                         'Binding %s and binding %s reference the same portType (%s) and have the same binding extension namespace \'%s\'.' +
                         ' Duplicate bindings are unusual and may indicate a problem with your wsdl.' +
                         ' Perhaps one of these bindings should use the SOAP 1.1 extension and the other should use the SOAP 1.2 extension.',
                         bindingNames[i], bindingNames[j], bind1.type, bind1.bindingNS));
                    }
                }
            }
            var services = u.makeSureItsAnArray(wsdlJson.definitions.service);
            var servLen = services.length;
            for (var k = 0; k < servLen; k++) {
                var service = services[k];
                var ports = u.makeSureItsAnArray(service.port);
                ports = onlySoapPorts(ports, data.bindings);
                service.port = ports;
                var portLen = ports.length;
                if (ports.length == 0) {
                    continue;
                }

                let serv = {
                    service: service['undefined'].name,
                    filename: allWSDLs[x].filename,
                };
                if (service.documentation) {
                    serv.description = u.cleanupDocumentation(service.documentation, req);
                }

                // Process the ports
                for (let l = 0; l < portLen; l++) {
                    let port = ports[l];
                    let portName = port['undefined'].name;
                    let obj;
                    if (l == 0) {
                        // This is the default port, and is set at the top level
                        serv.portName = portName;
                        obj = serv;
                    } else {
                        // Other ports are put in the port map
                        serv.ports = serv.ports || {};
                        serv.ports[portName] = {};
                        obj = serv.ports[portName];
                    }
                    obj.bindingName = u.stripNamespace(port['undefined'].binding);
                    // Make sure the service port (which uses either a soap 1.1 or soap 1.2 address)
                    // references a binding with that has a matching extension.
                    if (data.bindings[obj.bindingName] && port.address) {
                        const binding = data.bindings[obj.bindingName];
                        if (port.address['undefined']) {
                            if (port.address['undefined'].__namespace__ != binding.bindingNS) {
                                R.warning(req, g.http(u.r(req)).f(
                                 'The service port %s has an address with extension \'%s\', but the referenced binding (%s) uses extension \'%s\'. ' +
                                 'Please change the address to use the same extension as the binding. ' +
                                 'Processing continues, but this ambiguity may cause problems determining if this is a SOAP 1.1 or SOAP 1.2 port.',
                                portName, port.address['undefined'].__namespace__, obj.bindingName, binding.bindingNS));
                            }
                        }
                    }
                    let endpoint = '';
                    if (portLen > 0) {
                        if (ports[0].address &&
                            ports[0].address['undefined']) {
                            endpoint = ports[0].address['undefined'].location;
                        }
                    }
                    obj.endpoint = endpoint;
                    let type = data.bindings[obj.bindingName] ? data.bindings[obj.bindingName].type : null;
                    obj.operations = [];
                    if (type) {
                        let ops = data.portTypes[type];
                        if (ops) {
                            for (let m = 0; m < ops.length; m++) {
                                let opObj = {
                                    operation: ops[m].name
                                };
                                if (ops[m].description) {
                                    opObj.description = ops[m].description;
                                }
                                obj.operations.push(opObj);
                            }
                        } else {
                            R.error(req, g.http(u.r(req)).f('The portType %s is not found. This is a violation of a WS-I Rule (R2101 A DESCRIPTION MUST NOT use QName references to WSDL components in namespaces that have been neither imported, nor defined in the referring WSDL document).', type));
                        }
                    }
                }

                // Add service if there are actual serviceJSON
                // and the service in this first time that the service for this
                // file is encountered.
                // (The tns is checked because a service will occur multiple times in
                // allWSDLs for circular wsdl imports, so we use the tns to ensure that only
                // one of these is used).
                if (allWSDLs[x].serviceJSON && allWSDLs[x].serviceJSON != {}) {
                    if (!serviceMap[serv.service]) {
                        serviceMap[serv.service] = [];
                    }
                    var found = false;
                    for (var ss = 0; !found && ss < serviceMap[serv.service].length; ss++) {
                        let s = serviceMap[serv.service][ss];
                        if (s.fullName === allWSDLs[x].fullName ||
                            s.endpoint === serv.endpoint) {
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        serviceMap[serv.service].push(
                          {
                              serv: serv,
                              fullName: allWSDLs[x].fullName,
                              endpoint: serv.endpoint
                          });
                        data.services.push(serv);
                    }
                }
            } // end for
            for (let bindingName in data.bindings) {
                delete data.bindings[bindingName].bindingNS;
            }
        } // end for

        // Find duplicates and disambiguate the names
        // <serviceName>-from-<slugifyfullname>
        for (var s in serviceMap) {
            if (serviceMap[s].length > 1) {
                for (var z = 0; z < serviceMap[s].length; z++) {
                    serviceMap[s][z].serv.service += '-from-' + u.slugifyName(serviceMap[s][z].fullName);
                }
            }
        }
        return u.checkAndFix(data);
    } catch (error) {
        console.log(g.http(u.r(req)).f('Ignore error that occurred while parsing wsdl.'));
        console.log(error);
        R.error(req, error);
        return u.checkAndFix(data);
    }
}

/**
* @param ports is service.ports
* @param bindings is object containing keys that are soap bindings
* @return port array with just soap ports
*/
function onlySoapPorts(ports, bindings) {
    let ret = [];
    let portLen = ports.length;
    for (var i = 0; i < portLen; i++) {
        if (ports[i].address  && ports[i]['undefined']  && ports[i]['undefined'].binding) {
            let bindingName = u.stripNamespace(ports[i]['undefined'].binding);
            if (bindings[bindingName]) {
                ret.push(ports[i]);
            }
        }
    }
    return ret;
}

/**
* @param allWSDLs (from getJsonForWSDL)
* @param serviceName (wsdl service name)
* @param servieFileName (used as a differentiator if multiple services with the same name)
* @returns WSDLEntry object for the indicated service.
*/
function findWSDLForServiceName(allWSDLs, serviceName, serviceFilename) {
    var ret = null;
    var len = allWSDLs.length;
    // If multiple services of the same name were detected,
    // then the serviceName was changed to disambiguate the services
    // <serviceName>-from-<slugifiedpath>
    var slugifyServiceFullName;
    var mangleIndex = serviceName.indexOf('-from-');
    if (mangleIndex > 0) {
        slugifyServiceFullName = serviceName.substring(mangleIndex + 6);
        serviceName = serviceName.substring(0, mangleIndex);
        serviceFilename = null;
    }
    for (var i = 0; i < len; i++) {
        var wsdlEntry = allWSDLs[i];
        if (getService(serviceName, wsdlEntry.serviceJSON)) {
            if (slugifyServiceFullName && wsdlEntry.fullName) {
                if (slugifyServiceFullName == u.slugifyName(wsdlEntry.fullName)) {
                    ret = wsdlEntry;
                    break;
                }
            } else if (serviceFilename && wsdlEntry.filename) {
                if (serviceFilename == wsdlEntry.filename) {
                    ret = wsdlEntry;
                    break;
                }
            } else {
                ret = wsdlEntry;
                break;
            }
        }
    } // end for
    return ret;
}

function getService(serviceName, serviceJSON) {
    if (serviceJSON && serviceJSON.service) {
        serviceJSON.service = u.makeSureItsAnArray(serviceJSON.service);
        for (let i = 0; i < serviceJSON.service.length; i++) {
            let service = serviceJSON.service[i];
            if (service && service['undefined'] && service['undefined'].name === serviceName) {
                return service;
            }
        }
    }
    return null;
}

/**
 * Get allWSDLS from a single wsdl file (or zip)
 * @return promise { files: [], archive: new archive}
 */
async function parse(inFileName, auth, options) {
    let opts = options || {};
    let req = opts.req;
    // Get the rawContent of the files
    let out = await fileUtils.asContent(inFileName, inFileName, auth, null, req);
    var rawContent = out.content;
    let isZip = fileUtils.isZip(out.content);
    // Create an 'archive' of all of the files that will be needed.
    // In most cases, this archive will be a 'ZIP' archive, but in legacy mode it is a list of files.
    let isLegacy = out.fileName && !options.selfContained;
    let fileName = null;
    if (isLegacy) {
        fileName = inFileName;  // Use the full path
    } else {
        if (out.fileName) {
            let i = fileUtils.lastPathSeparator(out.fileName);
            fileName = i < 0 ? out.fileName : out.fileName.substr(i + 1);  // Get the short name
        }
    }
    // Convert the content into an archive
    let archive = await getArchive(out.content, req, options.flatten, fileName, isLegacy);

    // If the archive has options from a configuration file,
    // apply them to the options
    if (Object.keys(archive.options).length > 0) {
        options.config = archive.options;
    }
    if (options.config) {
        _.merge(options, options.config);
    }

    let fileSet = await parsePass1(archive, options);
    let result = await parsePass2(archive, fileSet, options);
    // If not zip, return file contents as archive
    if (!isZip) {
        result.content = options.sanitizeWSDL ? await sanitize(rawContent, req) : rawContent;
        delete result.archive;
    }
    return result;
}

async function parsePass1(archive, options, fileSet) {
    let req = options.req;
    let map = {};
    fileSet = fileSet || { };
    let processFileCount = 0;

    function shouldIgnoreFile(fileName, mode, req) {
        // Return true to ignore the file (silently)
        // Throw an error if invalid file.
        if (fileUtils.isSymbolicLink(mode)) {
            throw g.http(u.r(req)).Error('A file for a symbolic link was encountered in the zip.  Remove the file %s.', fileName);
        }
        if (fileUtils.isMACOSX(fileName) || fileUtils.isDirectory(fileName) || fileUtils.isConfig(fileName)) {
            return true; // silently ignore
        }
        if (fileUtils.isWSDL(fileName)) {
            return false;
        }
        if (fileUtils.isXSD(fileName) || fileUtils.isXML(fileName)) {
            if (options.apiFromXSD) {
                fileSet[fileName] = 'missing';  // Process all xsd files
            }
            return fileSet[fileName] !== 'missing';  // Ignore files that are not in the calculated fileSet.
        }

        if (!options.allowExtraFiles) {
            throw g.http(u.r(req)).Error('Only .xsd and .wsdl files are allowed in the zip.  Remove the file %s.', fileName);
        }
        return true;

    }

    function processFile(fileName, content, req) {
        processFileCount++;
        // Process the decoded content of the file.
        let ret = {
            fileName: fileName,
            content: null, // Set only if content should be changed in the output archive
        };

        try {
            // Do a fast parse to ensure quality
            new XML2JSparseString(content, function(err, result) {
                if (err) {
                    throw new Error(massageXMLParseMessage(err.message));
                }
            });
            // For the first pass, just calculate the referenced schema locations
            let dom = d.loadSafeDOM(content, req, fileName);
            map[fileName] = d.getLocations(dom, fileName, req).all;
            if (d.hasSchemaRef(dom)) {
                map[fileName].push('XMLSchema.xsd');
            }
        }  catch (e) {
            // For legacy reasons, xml errors are only reported if the file is included/imported.
            // So ignore errors during the first pass.
            if (fileUtils.isXML(fileName)) {
                map[fileName] = [];
            } else {
                throw e;
            }
        }
        return ret;
    }

    R.start(req, 'parsePass1');
    try {
        // If there are implicit header files, add them to the fileSet as a 'missing' reference so
        // that the parse pass will find and process them.
        if (options.implicitHeaderFiles) {
            for (let i = 0; i < options.implicitHeaderFiles.length; i++) {
                let fileName = options.implicitHeaderFiles[i];
                if (!fileSet[fileName]) {
                    fileSet[fileName] = 'missing';
                }
            }
        }

        let out = await fileUtils.pipeArchive(archive, req, shouldIgnoreFile, processFile);

        // If no files processed, then switch to apiFromXSD mode
        if (processFileCount === 0) {
            options.apiFromXSD = true;
            out = await fileUtils.pipeArchive(archive, req, shouldIgnoreFile, processFile);
        }

        // Collect any localized errors from the file processing, and reject if any found
        let messages = [];
        for (let i = 0; i < out.files.length; i++) {
            if (out.files[i].error) {
                messages.push(out.files[i].fileName + ': ' + out.files[i].error.message);
            }
        }
        if (messages.length > 0) {
            throw new Error(messages.join('\n'));
        } else {
            let existingFiles = Object.keys(fileSet);
            let allFiles = u.deepClone(existingFiles);
            for (let key in map) {
                fileSet[key] = map[key];
                allFiles = _.union(allFiles, map[key]);
            }

            let diff = _.difference(allFiles, existingFiles);
            let done = true;
            for (let j = 0; j < diff.length; j++) {
                // Check for file existence
                done = false;
                fileSet[diff[j]] = 'missing';
            }
            R.end(req, 'parsePass1');

            if (!done) {
                await parsePass1(archive, options, fileSet);
            }
        }
        return fileSet;
    } catch (err) {
        R.end(req, 'parsePass1', err);
        throw err;
    }
}

/**
* @param message - error message from xml parsing
* @return message with more information
*/
function massageXMLParseMessage(message) {
    let pre = 'An XML parsing error was found.  Please ensure that the file is a valid XSD or WSDL file. ';
    let detail = '';
    if (message.includes('Invalid character in entity')) {
        detail = 'This error indicates that an incorrect xml entity was discovered.  An xml entity starts with "&" and ends with ";" (example &lt;).' +
                 ' This message usually occurs when an "&" is not properly encoded as "&amp;". ';
    }
    return pre + detail + '[' + message + ']';
}

async function parsePass2(archive, fileSet, options) {
    let isExecutable = false;
    let req = options.req;
    let fileEntries = [];

    function shouldIgnoreFile(fileName, mode, req) {
        // Return true to ignore the file (silently)
        // Throw an error if invalid file.
        isExecutable = fileUtils.isExecutable(mode);
        if (fileUtils.isSymbolicLink(mode)) {
            throw g.http(u.r(req)).Error('A file for a symbolic link was encountered in the zip.  Remove the file %s.', fileName);
        }
        if (fileUtils.isMACOSX(fileName) || fileUtils.isDirectory(fileName)) {
            return true; // silently ignore
        }
        if (fileUtils.isXSD(fileName) || fileUtils.isWSDL(fileName) || fileUtils.isXML(fileName) || fileUtils.isConfig(fileName)) {
            return !fileSet[fileName];  // Ignore files that are not in the calculated fileSet.
        }

        if (!options.allowExtraFiles) {
            throw g.http(u.r(req)).Error('Only .xsd and .wsdl files are allowed in the zip.  Remove the file %s.', fileName);
        }
        return true;

    }

    function processFile(fileName, content, req) {
        // Process the decoded content of the file.
        R.start(req, 'parse2: ' + fileName);
        content = options.sanitizeWSDL ? sanitizeFile(content, req, fileName) : content;
        let ret = {
            fileName: fileName,
            content: options.sanitizeWSDL ? content : null // set if content is updated
        };
        try {
            var shortName = fileName;
            var index = fileUtils.lastPathSeparator(fileName);
            if (index != -1) {
                shortName = shortName.substr(index + 1);
            }

            // Create a file entry for allWSDLs
            var fileEntry = {
                filename: shortName,
                fullName: fileName,
                type: 'wsdl', // temp for now determined later when we actually parse it
                content: content,
                context: 'zip'
            };

            try {
                // For legacy reasons, it is possible that an xml file has schema.
                // If this xml file does not have schema then don't allow it.
                if (fileUtils.isXML(fileName)  && content.indexOf('schema') < 0) {
                    throw g.http(u.r(req)).Error('Only .xsd and .wsdl files are allowed in the zip.  Remove the file %s.', fileName);
                }
                parseUtils.contentToXMLorWSDL(fileEntry, options);
            } catch (e) {
                // If the file is not a wsdl, then save the error
                // and rethrow later only if it is is included or imported
                // We do this for migration reasons.
                if (fileUtils.isWSDL(fileName)  || isExecutable) {
                    throw e;
                } else {
                    fileEntry.error = e;
                    fileEntry.type = 'xsd';
                }
            }
            let valid = false;
            if (fileEntry.error) {
                fileEntries.push(fileEntry);
            } else if (fileEntry.json.definitions) {
                let checkWSDL = parseUtils.validateWSDLJson(fileEntry.json, fileEntry.filename);
                if (checkWSDL.valid) {
                    fileEntries.push(fileEntry);
                    fileEntry.type = 'wsdl';
                    valid = true;
                } else {
                    throw new Error(checkWSDL.reason);
                }
            } else if (fileEntry.json.schema) {
                fileEntries.push(fileEntry);
                fileEntry.type = 'xsd';
                fileEntry.namespaces = {};
                valid = true;
                // If this is the only file (not part of a zip),
                // then indicate that this an API built from an XSD file.
                if (fileEntry.filename === fileUtils.INTERNAL_WSDL) {
                    options.apiFromXSD = true;
                }
            } else {
                // Cannot parse the wsdl or xsd file.
                // If this is a wsdl then fail fast.
                // Else the error is saved and only issued if this file is needed
                let insert = fileEntry.filename === fileUtils.INTERNAL_WSDL ? '(input file)' : fileEntry.filename;
                let e = g.http(u.r(req)).Error('The content of file %s is not wsdl or xsd.  This file cannot be processed.  Please correct your input.', insert);
                if (fileUtils.isWSDL(fileName)) {
                    throw e;
                } else {
                    fileEntry.error = e;
                    fileEntry.type = 'xsd';
                    fileEntries.push(fileEntry);
                }
            }
        }  catch (e) {
            if (fileUtils.isXML(fileName)) {
                throw g.http(u.r(req)).Error('Only .xsd and .wsdl files are allowed in the zip.  Remove the file %s.', fileName);
            }
            throw e;
        }
        R.end(req, 'parse2: ' + fileName);
        return ret;
    }

    R.start(req, 'parsePass2');
    try {
        let out = await fileUtils.pipeArchive(archive, req, shouldIgnoreFile, processFile);
        // Collect any localized fatal errors from the file processing, and reject if any found
        let messages = [];
        for (let i = 0; i < out.files.length; i++) {
            if (out.files[i].error) {
                messages.push(out.files[i].fileName + ': ' + out.files[i].error.stack);
            }
        }
        if (messages.length > 0) {
            let error = new Error(messages.join('\n'));
            throw error;
        }
        R.end(req, 'parsePass2');
        return { files: fileEntries, archive: out.archive.content };
    } catch (err) {
        R.end(req, 'parsePass2', err);
        throw err;
    }
}

/**
* Get the content as an archive (which includes any core schemas)
* @param content of input
* @param req
* @param fileName of the input
* @param indicates if a legacy style archive is required (for tests)
**/
async function getArchive(content, req, flatten, fileName, isLegacy) {
    let archive = await fileUtils.asArchive(content, req, flatten, fileName, isLegacy);
    let buffer = fs.readFileSync(__dirname + '/files/XMLSchema.xsd');
    return await fileUtils.addFileToArchive(archive, 'XMLSchema.xsd', buffer);
}

/**
* sanitize WSDL (remove comment, documentation and unnecessary constructs)
* @param content buffer or string
* @param req i18n object
* @return sanitized buffer or string
*/
async function sanitize(content, req) {
    let isZip = fileUtils.isZip(content);
    if (!isZip) {
        if (typeof content === 'string') {
            return sanitizeFile(content, req);
        } else {
            let encoding = fileUtils.determineEncoding(content);
            let decodedContent = fileUtils.decode(content, encoding);
            return fileUtils.encode(sanitizeFile(decodedContent, req), encoding);
        }
    } else {
        let out = await fileUtils.asContent(content, content, null, null, req);
        let archive = await fileUtils.asArchive(out.content, req, false, null, false);
        archive = await sanitizeArchive(archive, req);
        return archive.content;
    }
}

/**
* sanitize file (remove comment, documentation and unnecessary constructs)
* @param content buffer or string
* @param req i18n object
* @param fileName for error messages
* @return sanitized buffer or string
*/
function sanitizeFile(content, req, fileName) {
    new XML2JSparseString(content, function(err, result) {
        if (err) {
            throw new Error(massageXMLParseMessage(err.message));
        }
    });
    let dom = d.loadSafeDOM(content);
    d.sanitizeDOM(dom);
    return d.serializeDOM(dom);
}

/**
* sanitize archive (remove comment, documentation and unnecessary constructs)
* @param archive
* @param req i18n object
* @return archive
*/
async function sanitizeArchive(archive, req) {
    function shouldIgnoreFile(fileName, mode, req) {
        // Return true to ignore the file (silently)
        // Throw an error if invalid file.
        if (fileUtils.isSymbolicLink(mode)) {
            throw g.http(u.r(req)).Error('A file for a symbolic link was encountered in the zip.  Remove the file %s.', fileName);
        }
        if (fileUtils.isMACOSX(fileName) || fileUtils.isDirectory(fileName)) {
            return true; // silently ignore
        }
        return false;
    }

    function processFile(fileName, content, req) {
        // Process the decoded content of the file.
        let ret = {
            fileName: fileName,
            content: null, // Set only if content should be changed in the output archive
        };
        if (fileUtils.isWSDL(fileName) || fileUtils.isXSD(fileName) || fileUtils.isXML(fileName)) {
            ret.content = sanitizeFile(content, req, fileName);
        }
        return ret;
    }

    let out = await fileUtils.pipeArchive(archive, req, shouldIgnoreFile, processFile);
    // Collect any localized errors from the file processing, and reject if any found
    let messages = [];
    for (let i = 0; i < out.files.length; i++) {
        if (out.files[i].error) {
            messages.push(out.files[i].fileName + ': ' + out.files[i].error.message);
        }
    }
    if (messages.length > 0) {
        throw new Error(messages.join('\n'));
    }
    return out.archive;
}

exports.getJsonForWSDL = getJsonForWSDL;
exports.getWSDLServices = getWSDLServices;
exports.getWSDLServicesAll = getWSDLServicesAll;
exports.findWSDLForServiceName = findWSDLForServiceName;
exports.sanityCheckDefinition = sanityCheckDefinition;
exports.sanitize = sanitize;
