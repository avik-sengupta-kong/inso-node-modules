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
const parseUtils = require('../lib/parseUtils.js');
const fileUtils = require('../lib/fileUtils.js');


const q = require('q');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');
const R = require('../lib/report.js');
const d = require('../lib/domUtils.js');

/**
* Functions that are performed after the node soap parsing but before generation for the apiconnect-wsdl parser
**/

async function merge(files, auth, options) {
    options = options || {};
    let allWSDLs = [];
    let hasBeenImported = {};
    let rootWSDLs = [];
    let i, entry;

    // Determine if the internal xmlschema file or implicit headers are used.
    // If yes, then imports are added for each file.
    let addImports = [];
    for (let j = 0; j < files.length; j++) {
        if (files[j].fullName === 'XMLSchema.xsd') {
            addImports.push({ fullName: 'XMLSchema.xsd', namespace: 'http://www.w3.org/2001/XMLSchema' });
        }
        if (options.implicitHeaderFiles && options.implicitHeaderFiles.indexOf(files[j].fullName) >= 0) {
            addImports.push({ fullName: files[j].fullName, namespace: files[j].json.schema['undefined'].targetNamespace });
            files[j].json.schema['undefined'].implicitHeaderSchema = true;
        }
    }
    if (addImports.length > 0) {
        for (let j = 0; j < files.length; j++) {
            entry = files[j];
            if (entry.type == 'wsdl') {
                if (entry.json.definitions && entry.json.definitions.types && entry.json.definitions.types.schema) {
                    // entry.json.definitions.types = entry.json.definitions.types || {};
                    // entry.json.definitions.types.schema = entry.json.definitions.types.schema || [ {} ];
                    entry.json.definitions.types.schema = u.makeSureItsAnArray(entry.json.definitions.types.schema);
                    entry.json.definitions.types.schema[0].import = u.makeSureItsAnArray(entry.json.definitions.types.schema[0].import) || [];
                    let slashes = (entry.fullName.match(/\//g) || []).length;
                    let root = '';
                    for (let i = 0; i < slashes; i++) {
                        root += '../';
                    }
                    for (let k = 0; k < addImports.length; k++) {
                        entry.json.definitions.types.schema[0].import.push({
                            undefined: {
                                namespace: addImports[k].targetNamespace,
                                schemaLocation: root + addImports[k].fullName
                            }
                        });
                    }
                }
            }
        }
    }

    // Now work out import hierarchy first
    let len = files.length;
    for (i = 0; i < len; i++) {
        entry = files[i];
        if (entry.type == 'wsdl') {
            if (entry.json.definitions.import) {
                let imports = u.makeSureItsAnArray(entry.json.definitions.import);
                let impLen = imports.length;
                for (let j = 0; j < impLen; j++) {
                    let imp = imports[j];
                    let location = imp['undefined'].location;
                    if (location) {
                        hasBeenImported[location] = true;
                    }
                } // end for
            }
        } else if (entry.type === 'xsd') {
            if (options.apiFromXSD) {
                if (entry.json.schema.import) {
                    let imports = u.makeSureItsAnArray(entry.json.schema.import);
                    let impLen = imports.length;
                    for (let j = 0; j < impLen; j++) {
                        let imp = imports[j];
                        let location = imp['undefined'].schemaLocation;
                        if (location) {
                            hasBeenImported[location] = true;
                        }
                    } // end for
                }
                if (entry.json.schema.include) {
                    let includes = u.makeSureItsAnArray(entry.json.schema.include);
                    let incLen = includes.length;
                    for (let j = 0; j < incLen; j++) {
                        let imp = includes[j];
                        let location = imp['undefined'].schemaLocation;
                        if (location) {
                            hasBeenImported[location] = true;
                        }
                    }
                }
            }
        }
    } // end for
    // now work out the root WSDLs from the list
    for (i = 0; i < len; i++) {
        entry = files[i];
        if (entry.type === 'wsdl' ||
            (entry.type === 'xsd'  && (options.strictValidation || options.apiFromXSD))) {
            if (!hasBeenImported[entry.fullName] && !hasBeenImported[entry.filename] ||
                (entry.serviceJSON && entry.serviceJSON != {})) {
                if (entry.fullName !== 'XMLSchema.xsd') {
                    rootWSDLs.push(entry);
                }
            }
        }
    } // end for

    // now merge each root WSDL chain
    let rootLen = rootWSDLs.length;
    let impDefs = [];
    for (i = 0; i < rootLen; i++) {
        let entry = rootWSDLs[i];
        if (entry.type == 'wsdl') {
            impDefs.push(checkOneWSDLImport(entry, allWSDLs, files, auth, options));
        } else if (entry.type == 'xsd') {
            if (!entry.serviceJSON) {
                let name = (entry.filename === fileUtils.INTERNAL_WSDL) ?
                    'XML REST Service' : 'XML REST Service for ' + entry.filename;
                entry.serviceJSON = {
                    service: [ { undefined: {
                        name: name,
                        endpoint: u.RESTFUL_XML_URL
                    } } ]
                };
            }
            impDefs.push(checkOneXSDImport(entry, allWSDLs, files, auth, options));
        }
    } // end for
    await q.all(impDefs);
    return allWSDLs;
}



async function expandWSDLImports(wsdlJson, baseFilename, files, mergeList, alreadySeen, refFile, auth, options) {
    if (wsdlJson.definitions.import) {
        let imports = u.makeSureItsAnArray(wsdlJson.definitions.import);
        let iLen = imports.length;
        for (let i = 0; i < iLen; i++) {
            let imp = imports[i];
            await expandOneWSDLImport(imp, baseFilename, files, mergeList, alreadySeen, refFile, wsdlJson, auth, options);
        } // end for
    }
    return;
}

/*
* set absoluteSchemaLocation on each import/include within the wsdl json
* @param wsdlJSON
* @param basePath
*/
function setAbsolute(WSDLjson, basePath) {
    // The import/includes are located in the types, type.schema, and type.schema.schema
    if (WSDLjson && WSDLjson.definitions && WSDLjson.definitions.types) {
        setAbsoluteImportAndIncludes(WSDLjson.definitions.types, basePath);
        if (WSDLjson.definitions.types.schema) {
            WSDLjson.definitions.types.schema = u.makeSureItsAnArray(WSDLjson.definitions.types.schema);
            WSDLjson.definitions.types.schema.forEach(function(schema) {
                setAbsoluteImportAndIncludes(schema, basePath);
                if (schema.schema) {
                    schema.schema = u.makeSureItsAnArray(schema, schema);
                    schema.schema.forEach(function(innerSchema) {
                        setAbsoluteImportAndIncludes(innerSchema, basePath);
                    });
                }
            });
        }
    }
    return;
}

/*
* set absoluteSchemaLocation on each import/include
* @param parent json
* @param basePath
*/
function setAbsoluteImportAndIncludes(parent, basePath) {
    if (parent.import) {
        parent.import = u.makeSureItsAnArray(parent.import);
        parent.import.forEach(function(obj) {
            setAbsoluteSchemaLocation(obj, basePath);
        });
    }
    if (parent.include) {
        parent.include = u.makeSureItsAnArray(parent.include);
        parent.include.forEach(function(obj) {
            setAbsoluteSchemaLocation(obj, basePath);
        });
    }
}

/*
* set absoluteSchemaLocation on this import/include
* @param obj - import or include
* @param basePath
*/
function setAbsoluteSchemaLocation(obj, basePath) {
    let location = obj && obj['undefined'] ? obj['undefined'].schemaLocation : null;
    if (location && (!(location.substr(0, 7) == 'http://' || location.substr(0, 8) == 'https://'))) {
        let fn = location.replace(/\\/g, '/');
        obj['undefined'].absoluteSchemaLocation = fileUtils.normalizeLocation(fn, basePath);
    }
}

function mergeWSDL(targetJson, sourceFile, targetFileNamespaces) {

    // Get the targetNamespace
    let sourceJson = sourceFile.json;
    let tns = '';
    if (sourceJson.definitions['undefined']) {
        if (sourceJson.definitions['undefined'].targetNamespace) {
            tns = sourceJson.definitions['undefined'].targetNamespace;
        }
    }

    // Calculate the path for the current file
    let fn = sourceFile.fullName.replace(/\\/g, '/');
    let basePath = '';
    let index = fn.lastIndexOf('/');
    if (index != -1) {
        basePath = fn.substring(0, index);
    }
    // Set the absolute schemaLocation on each import and include
    setAbsolute(sourceJson, basePath);

    // Merge the target namespaces into the local namespaces for this file.
    // The target (parent wsdl) prefixes are added first because we want to prefer those prefixes
    // in situations where we have two prefixes and the same namespace.
    let wsdlNamespaces = {};
    for (var key in targetFileNamespaces) {
        wsdlNamespaces[key] = targetFileNamespaces[key];
    }
    for (key in sourceFile.namespaces) {
        wsdlNamespaces[key] = sourceFile.namespaces[key];
    }

    // Merge the source namespaces into the global (target) namespaces
    for (key in sourceFile.namespaces) {
        if (!targetFileNamespaces[key]) {
            targetFileNamespaces[key] = sourceFile.namespaces[key];
        }
    }

    let firstEntry;
    for (key in sourceJson.definitions) {
        if (!targetJson.definitions[key]) {
            if (key == 'undefined') {
                // straight copy
                targetJson.definitions[key] = sourceJson.definitions[key];
            } else if (key == 'types') {
                // straight copy, add namespaces
                targetJson.definitions[key] = sourceJson.definitions[key];
                if (targetJson.definitions[key].schema) {
                    if (Array.isArray(targetJson.definitions[key].schema)) {
                        let schemaLen = targetJson.definitions[key].schema.length;
                        for (let k = 0; k < schemaLen; k++) {
                            let schema = targetJson.definitions[key].schema[k];
                            schema.wsdlXmlns = wsdlNamespaces;
                            schema.wsdlTns = tns;
                        } // end for
                    } else {
                        targetJson.definitions[key].schema.wsdlXmlns = wsdlNamespaces;
                        targetJson.definitions[key].schema.wsdlTns = tns;
                    }
                }
            } else {
                // array copy with metadata
                targetJson.definitions[key] = u.makeSureItsAnArray(sourceJson.definitions[key]);
                let keyLen = targetJson.definitions[key].length;
                for (let i = 0; i < keyLen; i++) {
                    let item = targetJson.definitions[key][i];
                    item.xmlns = wsdlNamespaces;
                    item.tns = tns;
                } // end for
            }
        } else {
            // merge copy, ignore root attributes
            if (key != 'undefined') {
                if (key == 'types') {
                    // types get merged one level down
                    // make sure the original schema list in the wsdl is an array
                    if (!Array.isArray(targetJson.definitions.types.schema)) {
                        firstEntry = targetJson.definitions.types.schema;
                        targetJson.definitions.types.schema = [];
                        targetJson.definitions.types.schema.push(firstEntry);
                    }
                    if (sourceJson.definitions.types) {
                        if (Array.isArray(sourceJson.definitions.types.schema)) {
                            targetJson.definitions.types.schema = targetJson.definitions.types.schema.concat(sourceJson.definitions.types.schema);
                        } else {
                            targetJson.definitions.types.schema.push(sourceJson.definitions.types.schema);
                        }
                    }
                } else {
                    // make sure the original list in the wsdl is an array
                    if (!Array.isArray(targetJson.definitions[key])) {
                        firstEntry = targetJson.definitions[key];
                        targetJson.definitions[key] = [];
                        targetJson.definitions[key].push(firstEntry);
                    }
                    if (Array.isArray(sourceJson.definitions[key])) {
                        let len = sourceJson.definitions[key].length;
                        for (let j = 0; j < len; j++) {
                            let srcItem = sourceJson.definitions[key][j];
                            try {
                                srcItem.xmlns = wsdlNamespaces;
                                srcItem.tns = tns;
                            } catch (e) {
                                // Might be prevented from adding xmlns if this is a protected like an wsdl:appinfo
                                // That is okay, just continue
                            }
                            targetJson.definitions[key].push(srcItem);
                        } // end for
                    } else {
                        let def = sourceJson.definitions[key];
                        try {
                            def.xmlns = wsdlNamespaces;
                            def.tns = tns;
                        } catch (e) {
                            // Might be prevented from adding xmlns if this is a protected like an wsdl:appinfo
                            // That is okay, just continue
                        }
                        targetJson.definitions[key].push(def);
                    }
                }
            }
        }
    } // end for
}

async function checkOneWSDLImport(rootWSDL, allWSDLs, files, auth, options) {
    let wsdlJson = rootWSDL.json;
    let fn = rootWSDL.fullName.replace(/\\/g, '/');
    let baseFilename = '';
    let index = fn.lastIndexOf('/');
    if (index != -1) {
        baseFilename = fn.substring(0, index);
    }
    let mergeList = [];
    let alreadySeen = {};

    await expandWSDLImports(wsdlJson, baseFilename, files, mergeList, alreadySeen, rootWSDL, auth, options);
    // now merge the fetched WSDLs into the master wsdl
    let mergeLen = mergeList.length;
    if (mergeLen > 0) {
        for (let j = 0; j < mergeLen; j++) {
            let mergeFile = mergeList[j];
            mergeWSDL(wsdlJson, mergeFile, rootWSDL.namespaces);
        } // end for
    }
    // also merge the schemas
    await checkForSchemaImports(wsdlJson, rootWSDL.fullName, files, rootWSDL, auth, options);
    let allEntry = {
        json: wsdlJson,
        namespaces: rootWSDL.namespaces,
        doc: rootWSDL.doc,
        serviceJSON: rootWSDL.serviceJSON,
        filename: rootWSDL.filename,
        fullName: rootWSDL.fullName
    };
    allWSDLs.push(allEntry);
    return;
}

async function checkOneXSDImport(rootDoc, allDocs, files, auth, options) {
    // make the return XSD look like a WSDL types schema
    let xsdJson = {
        definitions: {
            types: {
                schema: []
            }
        }
    };
    if (!rootDoc.json) {
        return;
    }
    xsdJson.definitions.types.schema.push(rootDoc.json.schema);
    let fn = rootDoc.fullName.replace(/\\/g, '/');
    let baseFilename = '';
    let index = fn.lastIndexOf('/');
    if (index != -1) {
        baseFilename = fn.substring(0, index);
    }
    let mergeList = [];
    let alreadySeen = {};
    await expandSchemaImports(rootDoc.json.schema, baseFilename, files, mergeList, alreadySeen, rootDoc, auth, false, options);
    // now merge the fetched schemas into the response
    let mergeLen = mergeList.length;
    if (mergeLen > 0) {
        for (let i = 0; i < mergeLen; i++) {
            let toMerge = mergeList[i];
            xsdJson.definitions.types.schema.push(toMerge.schema);
        } // end for
    }
    let allEntry = {
        json: xsdJson,
        namespaces: rootDoc.namespaces,
        doc: rootDoc.doc,
        serviceJSON: rootDoc.serviceJSON,
        filename: rootDoc.filename,
        fullName: rootDoc.fullName
    };
    allDocs.push(allEntry);
    return;
}

async function expandOneWSDLImport(imp, baseFilename, files, mergeList, alreadySeen, refFile, wsdlJson, auth, options) {
    let req = options.req;
    let location = imp && imp['undefined'] ? imp['undefined'].location : null;
    let importNamespace = imp && imp['undefined'] ? imp['undefined'].namespace : null;
    if (location) {
        let relativeFilename = '';
        if (!(location.substr(0, 7) == 'http://' || location.substr(0, 8) == 'https://')) {
            let fn = location.replace(/\\/g, '/');
            location = fileUtils.normalizeLocation(fn, baseFilename);
            let index = location.lastIndexOf('/');
            if (index != -1) {
                relativeFilename = location.substring(0, index);
            }
        }
        // see if we have a match in the files first
        let foundMatch = false;
        let alreadyKnown = false;
        if (!alreadySeen[location]) {
            let len = files.length;
            for (let j = 0; j < len; j++) {
                let entry = files[j];
                if (entry.fullName == location || entry.filename == location) {
                    // If errors were found in the file, throw the error
                    if (entry.error) {
                        throw entry.error;
                    }
                    alreadySeen[location] = true;
                    // recurse into the referenced WSDL to check for more imports
                    if (entry.type == 'wsdl') {
                        let tns = entry.json.definitions['undefined'] ? entry.json.definitions['undefined'].targetNamespace : '';
                        if (tns === '') {
                            R.error(req, g.http(u.r(req)).f('The namespace of wsdl import "%s" does not match' +
                            ' the missing targetNamespace in the definitions element located in file %s.' +
                            ' The targetNamespace of the imported definition is interpretted as "%s".', importNamespace, refFile.filename, importNamespace));
                            // Special case
                            // This is kinda like a chameleon import of wsdl.
                            // The best solution is to probably set the import namespace
                            entry.json.definitions['undefined'] = entry.json.definitions['undefined'] || {};
                            entry.json.definitions['undefined'].targetNamespace = importNamespace;
                            tns = importNamespace;
                        }
                        if (tns !== importNamespace) {
                            throw g.http(u.r(req)).Error('The namespace \'%s\' referenced on the \'import\' element must match the namespace of the imported wsdl \'%s\'. This error was found in file %s.  This is a violation of a WS-I Rule (R2005 The targetNamespace attribute on the wsdl:definitions element of a description that is being imported MUST have same the value as the namespace attribute on the wsdl:import element in the importing DESCRIPTION).', importNamespace, tns, location);
                        }
                        mergeList.push(entry);
                        await expandWSDLImports(entry.json, relativeFilename, files, mergeList, alreadySeen, refFile, auth, options);
                    } else {
                        // trying to force an XSD into a WSDL import - store it in the right place
                        R.error(req, g.http(u.r(req)).f('A schema file \'%s\' referenced on a wsdl \'import\' element. This error was found in file %s.  This is a violation of a WS-I Rule (R2005 The targetNamespace attribute on the wsdl:definitions element of a description that is being imported MUST have same the value as the namespace attribute on the wsdl:import element in the importing DESCRIPTION). The schema file is imported and processing continues.', entry.filename, baseFilename));
                        if (!wsdlJson.definitions.types) {
                            wsdlJson.definitions.types = {
                                schema: []
                            };
                        }
                        wsdlJson.definitions.types.schema = u.makeSureItsAnArray(wsdlJson.definitions.types.schema, true);
                        wsdlJson.definitions.types.schema.push(entry.json.schema);
                    }
                    return;
                }
            } // end for
        } else {
            foundMatch = true;
            alreadyKnown = true;
        }
        if (!foundMatch && refFile.context == 'zip') {
            throw g.http(u.r(req)).Error('Failed to find the file "%s" in the zip archive.' +
            ' The reference to the file is located in file %s.' +
            ' Ensure that the file is packaged in the zip file.', location, refFile.filename);
        } else if (alreadyKnown) {
            return;
        } else {
            throw g.http(u.r(req)).Error('The file "%s" is not found. Ensure that the file is packaged in a zip file.', location);
        }
    }
    return;
}

async function expandOneSchemaImport(imp, baseFilename, files, mergeList, alreadySeen, parentNS, isInclude, refFile, auth, isWSDLTypesSchema, options) {
    let req = options.req;
    let location = imp && imp['undefined'] ? imp['undefined'].schemaLocation : null;
    let importNamespace = imp && imp['undefined'] ? imp['undefined'].namespace : null;
    if (location) {
        let relativeFilename = '';
        if (!(location.substr(0, 7) == 'http://' || location.substr(0, 8) == 'https://')) {
            let fn = location.replace(/\\/g, '/');
            // Use the absolute schemaLocation if it was already calculated
            location = imp['undefined'].absoluteSchemaLocation || fileUtils.normalizeLocation(fn, baseFilename);
            let index = location.lastIndexOf('/');
            if (index != -1) {
                relativeFilename = location.substring(0, index);
            }
        }
        // see if we have a match in the files first
        let foundMatch = false;
        let alreadyKnown = false;
        if (!alreadySeen[location]) {
            let len = files.length;
            for (let k = 0; k < len; k++) {
                let entry = files[k];
                if (entry.fullName == location || entry.filename == location) {
                    // If errors were found in the file, throw the error now
                    if (entry.error) {
                        throw entry.error;
                    }
                    alreadySeen[location] = true;
                    if (entry.type == 'xsd') {
                        mergeList.push(entry.json);
                        if (entry.json.schema['undefined']) {
                            let tns = entry.json.schema['undefined'].targetNamespace;

                            // Add breadcrumb to the schema to indicate that it is the target of an import or include
                            if (isInclude) {
                                entry.json.schema['undefined'].fromInclude = true;
                            } else {
                                entry.json.schema['undefined'].fromImport = true;
                            }
                            entry.json.schema['undefined'].fileName = u.fileNameFromPath(location);

                            // If the targetnamespace of the schema and the namespace on the import do not match
                            // reject the wsdl.
                            if (!isInclude && tns && importNamespace && tns != importNamespace) {
                                throw g.http(u.r(req)).Error('The namespace \'%s\' referenced on the \'import\' element must match the namespace of the imported schema \'%s\'. This error was found in file %s.', importNamespace, tns, location);
                            }
                            if (!isInclude) {
                                // xsd:import check
                                // The imported schema target namespace must not match the targetNamespace of the parent.
                                if (tns === parentNS) {
                                    if (!isWSDLTypesSchema) {  // No checking if schema is in wsdl types
                                        throw g.http(u.r(req)).Error('The namespace \'%s\' referenced on the \'import\' element must not match parent schema namespace \'%s\'. This error was found in file %s.', tns, parentNS, location);
                                    }
                                }
                            } else {
                                // xsd: include check
                                if (tns && tns !== parentNS) {
                                    // Normal schema (has namespace)
                                    if (!isWSDLTypesSchema) {  // No checking if schema is in wsdl types
                                        throw g.http(u.r(req)).Error('The namespace \'%s\' referenced on the \'include\' element must match parent schema namespace \'%s\'. This error was found in file %s.', tns, parentNS, location);
                                    }
                                } else if (!tns) {
                                    // Chameleon include
                                }
                            }
                        }
                        // recurse into the referenced schema to check for more imports
                        await expandSchemaImports(entry.json.schema, relativeFilename, files, mergeList, alreadySeen, refFile, auth, false, options);
                        return;
                    } else {
                        // trying to force a WSDL into a schema import
                        mergeList.push(entry.json.definitions.types);
                        // recurse into the referenced schema to check for more imports
                        await expandSchemaImports(entry.json.definitions.types.schema, relativeFilename, files, mergeList, alreadySeen, refFile, auth, false, options);
                        return;
                    }
                }
            } // end for
        } else {
            foundMatch = true;
            alreadyKnown = true;
        }

        if (!foundMatch && refFile.context == 'zip') {
            throw g.http(u.r(req)).Error('Failed to find the file %s in the zip archive.' +
            ' The file is referenced in file %s.' +
            ' Ensure that the file is packaged in the zip file.', location, refFile.filename);
        } else if (alreadyKnown) {
            return;
        } else {
            throw g.http(u.r(req)).Error('The file %s is not found. Ensure that the file is packaged in a zip file.', location);
        }
    }
    return;
}

async function expandSchemaImports(inSchema, baseFilename, files, mergeList, alreadySeen, refFile, auth, isWSDLTypesSchema, options) {
    let schemaList = u.makeSureItsAnArray(inSchema);
    let schemaLen = schemaList.length;
    for (let i = 0; i < schemaLen; i++) {
        let schema = schemaList[i];
        let tns = '';
        if (schema['undefined']) {
            let targns = schema['undefined'].targetNamespace;
            if (targns) {
                tns = targns;
            }
        }
        let imports = null;
        let includes = null;
        if (schema.import) {
            imports = u.makeSureItsAnArray(schema.import);
        }
        if (schema.include) {
            includes = u.makeSureItsAnArray(schema.include);
        }
        if (imports) {
            // Note: must import from a different namespace
            let iLen = imports.length;
            for (let j = 0; j < iLen; j++) {
                let imp = imports[j];
                await expandOneSchemaImport(imp, baseFilename, files, mergeList, alreadySeen, tns, false, refFile, auth, isWSDLTypesSchema, options);
            } // end for
        }
        if (includes) {
            // Note: must import from the same namespace
            let inLen = includes.length;
            for (let k = 0; k < inLen; k++) {
                let impIn = includes[k];
                await expandOneSchemaImport(impIn, baseFilename, files, mergeList, alreadySeen, tns, true, refFile, auth, isWSDLTypesSchema, options);
            } // end for
        }
    } // end for
    return;
}

async function checkForSchemaImports(wsdlJson, wsdlFilename, files, refFile, auth, options) {
    let fn = wsdlFilename.replace(/\\/g, '/');
    let baseFilename = '';
    let index = fn.lastIndexOf('/');
    if (index != -1) {
        baseFilename = fn.substring(0, index);
    }
    let mergeList = [];
    let alreadySeen = {};
    // fetch any referenced schema files
    if (wsdlJson.definitions.types && wsdlJson.definitions.types.schema) {
        await expandSchemaImports(wsdlJson.definitions.types.schema, baseFilename, files, mergeList, alreadySeen, refFile, auth, true, options);
        // now merge the fetched schemas into the master wsdl
        let mergeLen = mergeList.length;
        if (mergeLen > 0) {
            // make sure the original schema list in the wsdl is an array
            if (!Array.isArray(wsdlJson.definitions.types.schema)) {
                let firstEntry = wsdlJson.definitions.types.schema;
                wsdlJson.definitions.types.schema = [];
                wsdlJson.definitions.types.schema.push(firstEntry);
            }
            for (let i = 0; i < mergeLen; i++) {
                let toMerge = mergeList[i];
                wsdlJson.definitions.types.schema.push(toMerge.schema);
            } // end for
        }
    }
    return;
}

function isWSAddressing(wsdlJson) {
    let defBindings = u.makeSureItsAnArray(wsdlJson.definitions.binding);
    let binLen = defBindings.length;
    for (let j = 0; j < binLen; j++) {
        let binding = defBindings[j];
        let usingAddressing = !!binding.UsingAddressing;
        if (usingAddressing) {
            return true;
        }
    }
    return false;
}

exports.merge = merge;
exports.isWSAddressing = isWSAddressing;
