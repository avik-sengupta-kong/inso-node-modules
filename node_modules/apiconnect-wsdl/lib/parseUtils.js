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
const fileUtils = require('../lib/fileUtils.js');
const R = require('../lib/report.js');
const model = require('../lib/model.js');

/* Utilities for parsing the WSDL/XSD files for apiconnect-wsdl */

var _ = require('lodash');
const q = require('q');
const url = require('url');
const xmldom = require('xmldom');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');

/**
* preParse the xml file content.
*
* 1) Add fake targetNamespaces if a schema lacks a targetNamespace
* 2) Add special ids to choice, sequence, etc. to preserve their order.
*    These ids will be used in the generation pass to ensure the constructs are properly ordered.
* 3) Look for DTDs and other fatal node types
* 4) Perform a quick syntax check.
* @return dom
*/
function preParse(fileContent, fileName, options) {
    let req = options.req;
    let dom = d.loadSafeDOM(fileContent, req, fileName);
    if (!dom || dom.childNodes.length === 0) {
        return dom;
    }

    // If a schema does not have a targetNamespace, add a fake one
    // Often wsdl files will have schemas without a targetnamespace simply to import other schemas.
    // These schemas can cause error messages during parsing, so we add fake namespaces to avoid
    // error messages (and other relate problems).
    R.start(req, 'tgtNS:' + fileName);

    let faketnsID = 0;
    let schemas = dom.getElementsByTagNameNS('http://www.w3.org/2001/XMLSchema', 'schema');
    for (var s = 0; s < schemas.length; s++) {
        let schema = schemas[s];
        if (!schema.getAttribute('targetNamespace')) {
            if (faketnsID == 0) {
                // Only add fakens if multiple schemas...updating the schema for just one instance
                // is not necessary and affects performance because we need to do a serialization
                // of this dom
                faketnsID++;
            } else {
                schema.setAttribute('targetNamespace', 'https:/APICTNS' + faketnsID++);
            }
        }
    }
    R.end(req, 'tgtNS:' + fileName);

    R.start(req, 'scan:' + fileName);

    // Walk the DOM looking for DOCTYPE and other unrecognized node types
    let badNames = [];
    let ALLOW_NMTOKEN = {
        definitions: true,
        part: true,
        input: true,
        output: true,
        fault: true,
    };
    let elementCount = 0;
    d.traverseDOM(dom, function(node, stack) {
        if (node.nodeType === 1) {
            elementCount++;
        }
        if (node.nodeName) {
            // Don't need appinfo or comments in the backend, and we don't want to parse its contents.  So remove it.
            if (node.localName === 'appinfo' || node.nodeName === '#comment') {
                node.parentNode.removeChild(node);
                node = null;
            }
            if (node && node.nodeType == 1) {
                // Enforce NMTOKEN or NCNames to prevent weird problems in backend.
                let name = node.getAttribute('name');
                if (name && node.namespaceURI) {
                    // Enforce compliance if namespaces is for a specification that the generator processes.
                    let info = d.getNamespaceInfo(node.namespaceURI);
                    if (info.base || info.extension) {
                        let valid = ALLOW_NMTOKEN[node.localName] ? u.isNMTOKEN(name) : u.isNCName(name);
                        if (!valid && _.indexOf(badNames, name) < 0) {
                            badNames.push(name);
                        }
                    }
                }

                // Make sure first node is a definitions or schema elements
                if (elementCount === 1) {
                    if (node.localName !== 'schema' && node.localName !== 'definitions') {
                        if (node.localName === 'description') {
                            throw g.http(u.r(req)).Error('Found a WSDL 2.0 description element in %s.  Only WSDL 1.1 and WSDL 1.2 are supported.', fileName);
                        } else {
                            throw g.http(u.r(req)).Error('Expected \'schema\' or \'definitions\' element but found \'%s\' in %s.  Please correct the WSDL or XSD file.', fileName);
                        }
                    }
                }
            }
        }
        return node;
    });

    if (badNames.length > 0) {
        throw g.http(u.r(req)).Error('Found xml name(s) that are not valid xml NCNames [ %s ] within file %s.  This is not supported.', badNames, fileName);
    }
    R.end(req, 'scan:' + fileName);

    R.start(req, 'prune:' + fileName);

    // Look for unknown or uncommon elements and names.  These are reported as detail messages.
    let map = d.getNamesMap(dom);
    if (map.nsMap['xml']) {
        R.info(req, g.http(u.r(req)).f('Found declaration xmlns:xml in file %s.  This is a violation of a WS-I Rule (R4005 A DESCRIPTION SHOULD NOT contain the namespace declaration xmlns:xml="http://www.w3.org/XML/1998/namespace").  Processing continues.', fileName));
    }
    for (let key in map.nodes) {
        let info = d.getNameInfo(key);
        if (!info.known) {
            R.detail(req, g.http(u.r(req)).f('Found unknown NCName %s in file %s', key, fileName));
        } else if (!info.common) {
            R.detail(req, g.http(u.r(req)).f('Found uncommon NCName %s in file %s.  This uncommon name is associated with %s', key, fileName, info.ns));
        }
    }
    let unknownAttrCount = 0;
    for (let key in map.attrs) {
        let info = d.getAttrInfo(key);
        if (!info.known && unknownAttrCount < 100) {
            R.detail(req, g.http(u.r(req)).f('Found unknown attribute %s in file %s', key, fileName));
            unknownAttrCount++;
        } else if (!info.common) {
            R.detail(req, g.http(u.r(req)).f('Found uncommon attribute %s in file %s.  This uncommon name is associated with %s', key, fileName, info.ns));
        }
    }

    // Remove all unknown elements from the DOM, also add apicID attributes (which are used to preserve ordering)
    dom = d.pruneAndAddID(dom);
    R.end(req, 'prune:' + fileName);

    // Promote nested namespace definitions to their ancestor schema.
    // The node soap package does not process nested namespace definitions correctly.
    R.start(req, 'promoteNamespaceDecls:' + fileName);
    d.promoteNamespaceDeclarations(dom);
    R.end(req, 'promoteNamespaceDecls:' + fileName);

    // Make sure the wsdl or xsd syntax is correct.
    // We don't want invalid wsdl or schema to enter the genrate processing.
    R.start(req, 'syntaxCheck:' + fileName);
    d.syntaxCheck(dom, fileName, req);
    R.end(req, 'syntaxCheck:' + fileName);

    return dom;
}

// Check for oddities in the WSDL json produced by node soap
function validateWSDLJson(wsdlJson, filename, req) {
    var ret = {
        valid: true
    };
    if (wsdlJson && wsdlJson.definitions) {
        if (wsdlJson.definitions.types) {
            if (Array.isArray(wsdlJson.definitions.types)) {
                // not valid to have more than one wsdl:types entry
                ret.valid = false;
                ret.reason = g.http(u.r(req)).f('A wsdl \'document\' must not contain more than one \'wsdl:types\' element. The file is %s.', filename);
            }
        }
        var correct = checkParentage(wsdlJson.definitions.types, 'types', 'extension', [ 'simpleContent', 'complexContent' ]);
        if (!correct) {
            ret.valid = false;
            ret.reason = g.http(u.r(req)).f('An \'extension\' element must be a child of a \'simpleContent\' or \'complexContent\' element. The file is %s.', filename);
        }
    } else if (wsdlJson && !wsdlJson.definitions) {
        ret.valid = false;
        ret.reason = g.http(u.r(req)).f('A wsdl \'document\' does not contain any valid content. The file is %s.', filename);
    }
    return ret;
}

/**
* Common utility function that converts raw content (file.content)
* into a json model.
*/
function contentToXMLorWSDL(file, options) {
    let req = options.req;
    R.start(req, 'quickFix:' + file.filename);

    // Store the original content
    file.doc = { xml: file.content };
    // Wrap documentation in CDATA
    file.content = d.protectDocumentation(file.content);
    R.end(req, 'quickFix:' + file.filename);

    R.start(req, 'preParse:' + file.filename);
    // Now do a preParse pass
    // This loads the dom, does minor transformations and syntax checking
    let dom = preParse(file.content, file.filename, options);
    R.end(req, 'preParse:' + file.filename);

    R.start(req, 'modelJSON:' + file.filename);
    // Now create an abbreviated model from the dom
    //    model.json (a smaller simplified view of the wsdl or schema)
    //    model.namespaces (the global namespace map if this is a wsdl)
    //    model.serviceJSON (the simplified view of the services if this is a wsdl)
    let m = model.dom2Model(dom, file.filename, req);
    _.extend(file, m);
    R.end(req, 'modelJSON:' + file.filename);
}


// Utility to check if objects with the name (elementName) only
// has parents whose name is in the validParents array.
function checkParentage(root, rootName, elementName, validParents) {
    var ret = true;
    if (root && rootName && elementName && validParents) {
        for (var name in root) {
            if (name == elementName) {
                if (validParents.indexOf(rootName) == -1) {
                    ret = false;
                    break;
                }
            }
            var item = root[name];
            if (item && typeof item === 'object') {
                var entries = u.makeSureItsAnArray(item);
                var len = entries.length;
                for (var i = 0; i < len; i++) {
                    var entry = entries[i];
                    ret = checkParentage(entry, name, elementName, validParents);
                    if (!ret) {
                        break;
                    }
                } // end for
                if (!ret) {
                    break;
                }
            }
        } // end for
    }
    return ret;
}

exports.contentToXMLorWSDL = contentToXMLorWSDL;
exports.validateWSDLJson = validateWSDLJson;
