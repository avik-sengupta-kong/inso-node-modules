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
const parse = require('../lib/parse.js');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');
const q = require('q');
const d = require('../lib/domUtils.js');
const copts = require('../lib/createOptions.js');
const R = require('../lib/report.js');
const fileUtils = require('../lib/fileUtils.js');
const JSZip = require('jszip');
var _ = require('lodash');

const SCHEMA_NS = 'http://www.w3.org/2001/XMLSchema';
const WSDL_NS = 'http://schemas.xmlsoap.org/wsdl/';

/**
 * Inline schemas imports/includes into wsdl file(s)
 * @param {Buffer or String file location or String url} wsdl or zip content
 * @param options (undefined)
 * @return Promise Buffer (zip) or String (single file)
 */
async function inline(wsdl, options) {
    let createOptions = copts.create(options);
    let req = createOptions.req;
    createOptions.flatten = 'disable';
    // Read the WSDL file to ensure that it is accurate, and get the
    // the reduced archived that contains just the wsdl and schema files.
    let allWSDLs = await parse.getJsonForWSDL(wsdl, createOptions.auth, createOptions);
    if (allWSDLs[0].archive) {
        // Read the reduced archive, get the file content of each file, and
        // return a new flattened zip.
        let archive = await fileUtils.asRawArchive(allWSDLs[0].archive, req);
        let fileContent = await getContentOfFilesInArchive(archive, createOptions);
        return await createFlattenedZipContent(fileContent, req);
    } else {
        // If not a zip file, just return this WSDL file's content
        return allWSDLs[0].content;
    }
}

/**
* Get content of each file in archive
* @param archive
* @return map (key: normalized file name, value: file content)
*/
async function getContentOfFilesInArchive(archive, options) {
    let req = options.req;
    let fileContent = { };

    // Return true to ignore this file
    function ignoreFile(fileName, mode, req) {
        // Return true to ignore the file (silently)
        return fileUtils.isDirectory(fileName);
    }

    // Process content of this file
    function processFileContent(fileName, content, req) {
        fileContent[fileName] = {
            decodedContent: content
        };
        return {
            fileName: fileName,
            content: null,  // Indicates content is not changed
        };
    }

    await fileUtils.pipeArchive(archive, req, ignoreFile, processFileContent);
    return fileContent;
}

/**
* Create a flattend outZip
* @param fileContent map of fileNames->decoded content from input zip
* @param promise output zip (as Buffer of content)
*/
async function createFlattenedZipContent(fileContent, req) {
    // Remove xml directives from all of the files
    for (let fileName in fileContent) {
        let content = fileContent[fileName].decodedContent;
        // Remove xml tags
        content = content.replace(/<\?.*\?>/g, '');
        fileContent[fileName].content = content;
    }

    // Get the full map of imported/include schema files for each wsdl file.
    for (let fileName in fileContent) {
        if (fileUtils.isWSDL(fileName)) {
            // Get xsd:imported and xsd:included files
            fileContent[fileName].schemaMap = getSchemas(fileName, fileContent, req);
        }
    }
    // Now that we have the schemaMap, the xsd import/includes can
    // now be removed from the file content
    for (let fileName in fileContent) {
        let content = fileContent[fileName].content;
        content = d.removeXSDImportsAndIncludes(content, req);
        fileContent[fileName].content = content;
    }
    // Now using the schemaMap, do the actual inlining of the schemas
    // into each wsdl file.  Add file to the output zip
    let outZip = new JSZip();
    for (let fileName in fileContent) {
        if (fileUtils.isWSDL(fileName)) {
            let schemaMap = fileContent[fileName].schemaMap;
            let wsdlDOM = d.loadSafeDOM(fileContent[fileName].content, req, fileName);
            for (let f in schemaMap) {
                for (let ns in schemaMap[f]) {
                    // Load the imported or included
                    let schemaDOM = d.loadSafeDOM(fileContent[f].content, req, fileName);
                    addSchemaToWSDL(wsdlDOM, schemaDOM, ns, f);
                }
            }
            fileContent[fileName].content = d.serializeDOM(wsdlDOM);
            outZip.file(fileName, fileContent[fileName].content);
        }
    }
    return await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
* For fileName, get a Map of all of the schemas that the file imports or includes
* (this method is recursive and retrieves the imports and includes of included/imported schemas)
* @param fileName
* @param fileContent (which has the content of each file)
* @param parentNS (for recursion, the namespace of the file that contains the include/import)
* @param map (for rersion)
* @return map (key is the normalized name of the included/imported schema file,
* value is a map of the whose keys are the namespaces to apply to the schema file)
*/
function getSchemas(fileName, fileContent, req, parentNS, map) {
    map = map || {};
    let dom = d.loadSafeDOM(fileContent[fileName].content, req, fileName);
    let currLocation = '';
    if (fileName) {
        let i = fileUtils.lastPathSeparator(fileName);
        currLocation = i < 0 ? '' : fileName.substring(0, i);
    }
    let imports = dom.getElementsByTagNameNS(SCHEMA_NS, 'import');
    if (imports && imports.length > 0) {
        for (let i = 0; i < imports.length; i++) {
            let location = getNormalizedLocation(imports[i], currLocation);
            let ns = getNamespace(imports[i], parentNS);
            if (!location) {
                // inlined temp schema
            } else if (map[location] && map[location][ns]) {
                // Already visited
            } else {
                map[location] = map[location] || {};
                map[location][ns] = true;
                getSchemas(location, fileContent, req, ns, map);
            }
        }
    }
    let includes = dom.getElementsByTagNameNS(SCHEMA_NS, 'include');
    if (includes && includes.length > 0) {
        for (let i = 0; i < includes.length; i++) {
            let location = getNormalizedLocation(includes[i], currLocation);
            let ns = getNamespace(includes[i], parentNS);
            if (!location) {
                // inlined temp schema
            } else if (map[location] && map[location][ns]) {
                // Visited
            } else {
                map[location] = map[location] || {};
                map[location][ns] = true;
                map = getSchemas(location, fileContent, req, ns, map);
            }
        }
    }

    return map;
}

function getNormalizedLocation(impinc, currLocation) {
    let location = impinc.getAttribute('schemaLocation');
    if (location) {
        location = fileUtils.normalizeLocation(location, currLocation, true);
    }
    return location;
}

function getNamespace(impinc, parentNS) {
    let ns = impinc.getAttribute('namespace');
    if (!ns) {
        // Use the targetNamespace of the parent schema if no namespace attribute
        ns = impinc.parentNode.getAttribute('targetNamespace') || parentNS;
    }
    return ns;
}

function addSchemaToWSDL(wsdlDOM, schemaDOM, ns, fileName) {
    let wsdlTypes = wsdlDOM.getElementsByTagNameNS(WSDL_NS, 'types')[0];
    let schema = schemaDOM.getElementsByTagNameNS(SCHEMA_NS, 'schema')[0];
    if (!schema.getAttribute('targetNamespace')) {
        schema.setAttribute('targetNamespace', ns);
    }
    wsdlTypes.appendChild(wsdlDOM.createTextNode('\n'));
    wsdlTypes.appendChild(wsdlDOM.createComment('Start: inlined schema from file ' + fileName + ' with namespace ' + ns));
    wsdlTypes.appendChild(wsdlDOM.createTextNode('\n'));
    wsdlTypes.appendChild(schema);
    wsdlTypes.appendChild(wsdlDOM.createTextNode('\n'));
    wsdlTypes.appendChild(wsdlDOM.createComment('End: inlined schema from ' + fileName + ' with namespace ' + ns));
    wsdlTypes.appendChild(wsdlDOM.createTextNode('\n'));

}

exports.inline = inline;
