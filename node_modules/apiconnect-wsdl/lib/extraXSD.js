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
const generateSwagger = require('../lib/generateSwagger.js');
const parseUtils = require('../lib/parseUtils.js');
const fileUtils = require('../lib/fileUtils.js');
const JSZip = require('jszip');


const postParse = require('../lib/postParse.js');
const copts = require('../lib/createOptions.js');

const q = require('q');
const yauzl = require('yauzl');
const path = require('path');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');

/**
 * Get the Swagger for additional xsd schema.
 * @method getDefinitionsForXSD
 * @param {String} filename - xsd file
 * @param {Object} auth - auth info for accessing xsd file
 * @param {String[]} rootElementList - if set only process the rootElements in the list (and referencedDefs)
 * @param {Object} createOperationDesc
 * @return {Object} swagger.definitions
 **/
async function getDefinitionsForXSD(filename, auth, rootElementList, options) {
    rootElementList = u.makeSureItsAnArray(rootElementList);

    let createOptions = copts.create({
        fromGetDefinitionsForXSD: true,
        rootElementList: rootElementList
    }, options);
    let serviceName = 'TEMPLATE';
    let wsdlId = 'TEMPLATE';
    let req = createOptions.req;

    // Creates a temporary wsdl file containing xsd:imports for each
    // of the schemas
    let out = await createTemporaryWSDL(filename, auth, req);
    let outZip = await JSZip.loadAsync(out.archive.content);
    outZip.file('TEMPLATE.wsdl', out.wsdlContent);
    let content = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    let allWSDLs = await parse.getJsonForWSDL(content, null, createOptions);

    // Get the WSDLEntry for the serviceName
    var wsdlEntry = parse.findWSDLForServiceName(allWSDLs, serviceName);

    // Get the swagger for the service.  This will be the template service with
    // a definition section that contains our extra xsd definitions.
    let swagger = generateSwagger.getSwaggerForService(wsdlEntry, serviceName, wsdlId, createOptions);
    return swagger.definitions;
}

async function createTemporaryWSDL(filename, auth, req) {
    // The template wsdl is "just enough" wsdl to make a swagger document.
    let templateWSDL = path.resolve(__dirname, '../src/template.wsdl');
    let serviceName = 'TEMPLATE';
    let data = await getTargetNamespacesForXSD(filename, auth, req);
    let out = await fileUtils.asContent(templateWSDL, templateWSDL, null, null, req);
    // wsdlContent is the template wsdl content
    // Add xsd:imports for each of the files in the fileEntryList
    let wsdlContent = out.content.replace(/{SERVICE}/gi, serviceName);
    var stmts = '';
    for (var j = 0; j < data.files.length; j++) {
        let fileEntry = data.files[j];
        var stmt = '<xsd:import namespace="{TNS}" schemaLocation="{FILENAME}" {XMLNS} />\n';
        stmt = stmt.replace(/{FILENAME}/gi, fileEntry.filename);
        stmt = stmt.replace(/{TNS}/gi, fileEntry.targetNamespace);
        var xmlns = '';
        if (fileEntry.prefix) {
            xmlns = 'xmlns:' + fileEntry.prefix + '="' + fileEntry.targetNamespace + '"';
        }
        stmt = stmt.replace(/{XMLNS}/gi, xmlns);


        stmts += stmt;
    }
    wsdlContent = wsdlContent.replace(/{IMPORTS}/gi, stmts);
    return { wsdlContent: wsdlContent, archive: data.archive };
}

/**
 * Get the targetnamespaces for the indicated file
 * @method getTargetNamespacesForXSD
 * @param {String} filename - file name
 * @param {Object} auth - authorization information
 * @param {Promise}  promise containing fileEntry (with targetNamespace and prefix) and new archive
 */
async function getTargetNamespacesForXSD(filename, auth, req) {
    var files = [];
    let out = await fileUtils.asContent(filename, filename, auth, null, req);
    let archive = await fileUtils.asRawArchive(out.content, req);

    function shouldIgnore(fileName, mode, req) {
        // Return true to ignore the file (silently)
        // Throw an error if invalid file.
        if (fileUtils.isSymbolicLink(mode)) {
            throw g.http(u.r(req)).Error('A file for a symbolic link was encountered in the zip.  Remove the file %s.', fileName);
        }
        if (fileUtils.isMACOSX(fileName) || fileUtils.isDirectory(fileName)) {
            return true; // silently ignore
        }
        if (fileUtils.isXSD(fileName) || fileUtils.isWSDL(fileName)) {
            return false; // Don't ignore, process this file
        }

        throw g.http(u.r(req)).Error('Only .xsd and .wsdl files are allowed in the zip.  Remove the file %s.', fileName);
    }

    function processFile(fileName, content, req) {
        let shortName = fileName;
        let index = fileUtils.lastPathSeparator(fileName);
        if (index != -1) {
            shortName = shortName.substr(index + 1);
        }
        var file = {
            filename: shortName,
            fullName: fileName,
            type: 'xsd', // temp for now determined later when we actually parse it
            content: content,
            context: 'zip'
        };
        parseUtils.contentToXMLorWSDL(file, { req: req });
        if (file.json.definitions) {
            // This is WSDL, skip it.
        } else if (file.json.schema) {
            // Get namespaces
            files.push(file);
            file.namespaces = {};
            if (file.json.schema['undefined'] && file.json.schema['undefined'].targetNamespace) {
                file.targetNamespace = file.json.schema['undefined'].targetNamespace;
                file.prefix = u.getPrefixForNamespace(file.targetNamespace,
                    file.json.schema.xmlns);
            }
            return {
                fileName: fileName
            };
        } else {
            // Ignore other files
        }
        return null;
    }
    out = await fileUtils.pipeArchive(archive, req, shouldIgnore, processFile);
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
    return { files: files, archive: out.archive };
}

exports.createTemporaryWSDL = createTemporaryWSDL;
exports.getDefinitionsForXSD = getDefinitionsForXSD;
