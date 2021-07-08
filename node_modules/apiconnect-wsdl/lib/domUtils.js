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
const u = require('../lib/utils.js');
const fileUtils = require('../lib/fileUtils.js');
const xmldom = require('xmldom');
const g = require('../lib/strong-globalize-fake.js');
const R = require('../lib/report.js');
const NAMESPACE_URI = 'http://www.w3.org/2000/xmlns/';

/**
* @return information about the indicated namespace
*/
function getNamespaceInfo(namespace) {
    return NAMESPACE_INFO[namespace] || {
        known: false,
        base: false,
        extension: true,
        for: 'UNKNOWN'
    };
}

/**
* @return namespaces that we have seen before (i.e. spec namespaces)
*/
function getKnownNamespaces() {
    let known = [];
    for (let ns in NAMESPACE_INFO) {
        if (NAMESPACE_INFO[ns].known) {
            known.push(ns);
        }
    }
    return known;
}

/**
* @return info about this node ncName
*/
function getNameInfo(ncName) {
    if (_.indexOf(COMMOM_NODE_NAMES, ncName) >= 0) {
        return {
            known: true,
            common: true
        };
    } else if (UNCOMMON_NODE_NAMES[ncName]) {
        return {
            known: true,
            common: false,
            ns: UNCOMMON_NODE_NAMES[ncName]
        };
    } else {
        return {
            known: false,
            common: false,
            ns: 'unknown'
        };
    }
}

/**
* @return info about this attribute ncName
*/
function getAttrInfo(ncName) {
    if (_.indexOf(COMMOM_ATTR_NAMES, ncName) >= 0) {
        return {
            known: true,
            common: true
        };
    } else if (UNCOMMON_ATTR_NAMES[ncName]) {
        return {
            known: true,
            common: false,
            ns: UNCOMMON_ATTR_NAMES[ncName]
        };
    } else {
        return {
            known: false,
            common: false,
            ns: 'unknown'
        };
    }
}

/**
* Loads a DOM and does extra checking to ensure no DTDs or other illegal node types are
* within the DOM.
* @param text to parse
* @req I18N object
* @fileName optional file name for messages
* @return load an xmldom from text
*/
function loadSafeDOM(text, req, fileName) {
    let report = {
        warnings: [],
        errors: []
    };
    // Convert text into a DOM
    let dom = new xmldom.DOMParser({
        errorHandler: {
            warning: function(msg) {
                report.warnings.push(msg);
            },
            error: function(msg) {
                report.errors.push(msg);
            },
            fatalError: function(msg) {
                report.errors.push(msg);
            }
        } }).parseFromString(text, 'text/xml');
    // Check errors or warnings
    if (report.errors.length > 0 || report.warnings.length > 0) {
        let msg = JSON.stringify(report);
        if (msg.includes('entity not found')) {
            if (fileName) {
                throw g.http(u.r(req)).Error('Found a node type of %s within file %s.  This is not supported.', 'ENTITY', fileName);
            } else {
                throw g.http(u.r(req)).Error('Found a node type of %s.  This is not supported.', 'ENTITY');
            }
        } else {
            throw new Error(msg);
        }
    }
    // If there are DTD or other unsupported node types, then throw an appropriate error
    if (dom) {
        checkDOM(dom, req, fileName);
    }
    return dom;
}

/**
* Quick check of the DOM to make sure it does not contain DTDs or other unsupported node types
* @dom
* @req I18N object
* @fileName optional file name for messages
* throws error if problems found
*/
function checkDOM(dom, req, fileName) {
    traverseDOM(dom, function(node) {
        let info = getNodeTypeInfo(node.nodeType);
        if (info.report) {
            if (fileName) {
                throw g.http(u.r(req)).Error('Found a node type of %s within file %s.  This is not supported.', info.name, fileName);

            } else {
                throw g.http(u.r(req)).Error('Found a node type of %s.  This is not supported.', info.name);
            }
        }
    });
}

function serializeDOM(dom) {
    let serializer = new xmldom.XMLSerializer();

    // The xml dom serializer does not serialize > as &gt; within text nodes
    // which then causes downstream problems.
    traverseDOM(dom, function(node) {
        if (node.nodeName) {
            if (node.nodeName === '#text') {
                // If not whitespace, then obfuscate the text
                let data = node.data;
                if (data) {
                    node.data = data.replace(/>/g, 'APIC_GT_BREADCRUMB');
                }
            }
        }
        return node;
    });
    let s = serializer.serializeToString(dom);
    s = s.replace(/APIC_GT_BREADCRUMB/g, '&gt;');
    return s;
}

/**
* Traverse dom
* @param node (start with root)
* @param f callback for each node
* @param list (optional) ancestor schema and definitions
* @param postfix (optional) callback after processing the node
*/
function traverseDOM(node, f, list, postfix) {
    list = list || [];
    if (!node) {
        return;
    }
    // A null value returned from f indicates that the descendents
    // are not processed.
    node = f(node, list);
    if (node && node.childNodes) {
        let isSchemaOrDef = (node.localName === 'schema' || node.localName === 'definitions');
        if (isSchemaOrDef) {
            list.push(node);
        }
        // Must create a copy of the childNodes prior to traversing
        // the children because a descendent call to f may delete a node.
        let childNodes = [];
        for (let i = 0; i < node.childNodes.length; i++) {
            childNodes.push(node.childNodes[i]);
        }
        for (let i = 0; i < childNodes.length; i++) {
            traverseDOM(childNodes[i], f, list, postfix);
        }
        if (isSchemaOrDef) {
            list.pop();
        }
    }
    if (node && postfix) {
        postfix(node, list);
    }
}

/**
* @return a list of locations referenced from this file (via include, import).  The locations are normalized.
*/
function getLocations(doc, fileName, req) {

    let currLocation = '';
    if (fileName) {
        let lastSlash = fileName.lastIndexOf('/');
        let lastBSlash = fileName.lastIndexOf('\\');
        let i = lastSlash >= lastBSlash ? lastSlash : lastBSlash;
        currLocation = i < 0 ? '' : fileName.substring(0, i);
    }
    let locations = {
        all: [],
        xsdincludes: [],
        xsdimports: [],
        xsdredefines: [],
        wsdlimports: []
    };
    let e = doc.getElementsByTagNameNS(SCHEMA_NS, 'include');
    for (let i = 0; i < e.length; i++) {
        let newLocation = e[i].getAttribute('schemaLocation');
        if (newLocation) {
            let location = fileUtils.normalizeLocation(newLocation, currLocation, true);
            if (locations.all.indexOf(location) < 0) {
                locations.all.push(location);
            }
            if (locations.xsdincludes.indexOf(location) < 0) {
                locations.xsdincludes.push(location);
            }
        }
    }
    e = doc.getElementsByTagNameNS(SCHEMA_NS, 'import');
    for (let i = 0; i < e.length; i++) {
        let newLocation = e[i].getAttribute('schemaLocation');
        if (newLocation) {
            let location = fileUtils.normalizeLocation(newLocation, currLocation, true);
            if (locations.all.indexOf(location) < 0) {
                locations.all.push(location);
            }
            if (locations.xsdimports.indexOf(location) < 0) {
                locations.xsdimports.push(location);
            }
        }
    }
    e = doc.getElementsByTagNameNS(SCHEMA_NS, 'redefine');
    for (let i = 0; i < e.length; i++) {
        let newLocation = e[i].getAttribute('schemaLocation');
        if (newLocation) {
            let location = fileUtils.normalizeLocation(newLocation, currLocation, true);
            if (locations.all.indexOf(location) < 0) {
                locations.all.push(location);
            }
            if (locations.xsdredefines.indexOf(location) < 0) {
                locations.xsdredefines.push(location);
            }
        }
    }
    e = doc.getElementsByTagNameNS(WSDL_NS, 'import');
    for (let i = 0; i < e.length; i++) {
        let newLocation = e[i].getAttribute('location');
        if (newLocation) {
            let location = fileUtils.normalizeLocation(newLocation, currLocation, true);
            if (locations.all.indexOf(location) < 0) {
                locations.all.push(location);
            }
            if (locations.wsdlimports.indexOf(location) < 0) {
                locations.wsdlimports.push(location);
            }
        } else {
            R.warning(req, g.http(u.r(req)).f('A wsdl import does not have a location attribute. This is a violation of a WS-I Rule (R2007 A DESCRIPTION MUST specify a non-empty location attribute on the wsdl:import element).  This problem was found in file %s.', fileName));
        }
    }
    return locations;
}

/**
* Normally namespaces are declared on the wsdl or schema element.
* However it is also legal to declare namespaces on nested elements.
* A nested namespace declaration can cause problems if the prefix is already
* used to declare a different namespace.  The node soap package does not properly
* process these kinds of declarations.
*
* The solution is to promote nested namespace declarations to the ancestor schema.
* If a collision is detected, the nested prefix is renamed, and the nested references
* to the prefix are changed to use the prefix name.
* @param dom
*/
function promoteNamespaceDeclarations(dom) {
    let schemaInfo = [];
    let updateInfo = [];
    let inner = 0;
    const CONFLICT_PREFIX = 'apicPrefix';

    function processNode(node) {
        if (node.nodeType === ELEMENT_NODE) {
            let isSchema = node.localName === 'schema'  && node.namespaceURI === SCHEMA_NS;
            let nsMap = getNSMap(node);
            if (isSchema) {
                // This is a schema element, push the information
                schemaInfo.push({ node: node, nsMap: nsMap });
            } else if (schemaInfo.length > 0) {
                // This is a nested element, check for nested namespace declarations
                let schemaNSMap = _.last(schemaInfo).nsMap;
                let updateMap = {};
                let updateNeeded = false;
                for (let prefix in nsMap) {
                    if (!schemaNSMap[prefix]) {
                        // New prefix: promote
                        schemaNSMap[prefix] = nsMap[prefix];
                    } else if (schemaNSMap[prefix] != nsMap[prefix]) {
                        // Colliding prefix

                        // Remove the namespace declaration on the current node
                        node.removeAttributeNS(NAMESPACE_URI, prefix ? prefix : 'xmlns');

                        // Choose a new prefix name, either an existing prefix for the same namespace
                        // or a completely new prefix name
                        let existingPrefix;
                        for (let p in schemaNSMap) {
                            if (schemaNSMap[p] === nsMap[prefix]) {
                                existingPrefix = p;
                                break;
                            }
                        }
                        let newPrefix = existingPrefix || CONFLICT_PREFIX + inner++;
                        schemaNSMap[newPrefix] = nsMap[prefix];

                        // Add the old/new prefixes the update map so that references can be updated.
                        updateMap[prefix] = newPrefix;
                        updateNeeded = true;
                    }
                }
                if (updateNeeded) {
                    let oldUpdateMap = updateInfo.length === 0 ? {} : u.deepClone(_.last(updateInfo).map);
                    updateInfo.push({
                        node: node,
                        map: _.assign(oldUpdateMap, updateMap)
                    });
                }
            }
        }
        return node;
    }
    function postNode(node) {
        if (node.nodeType === ELEMENT_NODE) {
            let isSchema = node.localName === 'schema'  && node.namespaceURI === SCHEMA_NS;
            if (isSchema) {
                let schemaNSMap = _.last(schemaInfo).nsMap;
                // Set new declarations on the schema element
                for (let prefix in schemaNSMap) {
                    let name = prefix.length === 0 ? 'xmlns' : 'xmlns:' + prefix;
                    if (!node.hasAttribute(name)) {
                        node.setAttributeNS(NAMESPACE_URI, name, schemaNSMap[prefix]);
                    }
                }
                schemaInfo.pop();
            } else if (updateInfo.length > 0) {
                // This is a nested node and references must be updated.
                changePrefixRefs(node, _.last(updateInfo).map);
                if (_.last(updateInfo).node === node) {
                    updateInfo.pop();
                }
            }
        }
        return node;
    }
    traverseDOM(dom, processNode, [], postNode);
    return dom;
}

/**
* @return map (key: prefix, value: namespace) for all attributes declared on this node
*/
function getNSMap(node) {
    let map = {};
    if (node.attributes) {
        for (let i = 0; i < node.attributes.length; i++) {
            let attr = node.attributes[i];
            if (attr.namespaceURI === NAMESPACE_URI) {
                map[attr.localName === 'xmlns' ? '' : attr.localName] = attr.nodeValue;
            }
        }
    }
    return map;
}
/**
* Change references in this node from the old prefix to the new prefix
* @param node
* @param updateMap (key is old prefix, value is new prefex)
*/
function changePrefixRefs(node, updateMap) {
    let attrNames = [ 'base', 'type', 'ref' ];
    for (let oldPrefix in updateMap) {
        let newPrefix = updateMap[oldPrefix];
        if (oldPrefix === '') {
            // Old reference is to the default namespace (no prefix)
            attrNames.forEach(function(name) {
                let value = node.getAttribute(name);
                if (value && !value.includes(':')) {
                    node.setAttribute(name, newPrefix + ':' + value);
                }
            });
        } else {
            // Old reference uses a prefix (this is the normal case)
            attrNames.forEach(function(name) {
                let value = node.getAttribute(name);
                if (value && value.startsWith(oldPrefix + ':')) {
                    let newPrefixRef = newPrefix === '' ? '' : newPrefix + ':';
                    value = _.replace(value, oldPrefix + ':', newPrefixRef);
                    node.setAttribute(name, value);
                }
            });
        }
    }
}

/**
* @return true if document has a ref to a schema element (uncommon)
*/
function hasSchemaRef(doc) {
    let hasSchema = false;
    traverseDOM(doc, function(node) {
        if (node.nodeType === ELEMENT_NODE) {
            let ref = node.getAttribute('ref');
            if (ref && (ref === 'schema' || ref.endsWith(':schema'))) {
                hasSchema = true;
            }
        }
        return node;
    });
    return hasSchema;
}

/**
* @param dom for XSD or WSDL
* @return map of names of nodes and attributes and namespaces declarations
*/
function getNamesMap(dom) {
    let map = { nodes: {}, attrs: {}, namespaces: {}, nsMap: {} };
    traverseDOM(dom, function(node) {
        // Don't get the element/attribute names on annotations or its contents
        if (node.namespaceURI === SCHEMA_NS && node.localName === 'annotation') {
            return null;
        }
        if (node.nodeName) {
            let i = node.nodeName.indexOf(':');
            let name = i > -1 ? node.nodeName.substring(i + 1) : node.nodeName;
            map.nodes[name] = map.nodes[name] ? map.nodes[name]++ : 1;
        }
        if (node.attributes) {
            for (let i = 0; i < node.attributes.length; i++) {
                let attr = node.attributes[i].nodeName;

                if (attr.startsWith('xmlns:') || attr === 'xmlns') {
                    let ns = node.attributes[i].nodeValue;
                    map.namespaces[ns] = map.namespaces[ns] ? map.namespaces[ns]++ : 1;
                    let prefix = attr === 'xmlns' ? '' : node.attributes[i].localName;
                    let value = map.nsMap[prefix] || [];
                    if (value.indexOf(ns) < 0) {
                        value.push(ns);
                        map.nsMap[prefix] = value;
                    }
                    continue;
                }
                let index = attr.indexOf(':');
                let name = index > -1 ? attr.substring(index + 1) : attr;
                map.attrs[name] = map.attrs[name] ? map.attrs[name]++ : 1;
            }
        }
        return node;
    });
    return map;
}

/**
* @return information about this nodetype
*/
function getNodeTypeInfo(nodetype) {
    return NODE_TYPE[nodetype] || { keep: true, report: true, name: 'UNKNOWN TYPE' + nodetype };
}

/**
* @return DOM with DTD and other bad nodes removed
*/
function removeDTD(dom) {
    traverseDOM(dom, function(node) {
        let info = getNodeTypeInfo(node.nodeType);
        if (info.keep) {
            return node;
        } else {
            node.parentNode.removeChild(node);
            return null;
        }
    });
}

/**
* @return DOM with DTD and other bad nodes removed
*/
function removeXSDImportsAndIncludes(text, req) {
    let dom = loadSafeDOM(text, req);
    traverseDOM(dom, function(node) {
        if (node.nodeType === ELEMENT_NODE) {
            if (node.localName === 'import'  && node.namespaceURI === SCHEMA_NS ||
                node.localName === 'include' && node.namespaceURI === SCHEMA_NS) {
                node.parentNode.removeChild(node);
                return null;
            }
        }
        return node;
    });
    return serializeDOM(dom);
}

/*
* Sanitize DOM
* Removes comments, documentation, appinfo, unnecessary elements and attributes from the DOM
* @param dom
*/
function sanitizeDOM(dom) {
    traverseDOM(dom, function(node) {
        switch (node.nodeType) {
        case COMMENT_NODE:
            // Comments are not needed
            node.parentNode.removeChild(node);
            node = null;
            break;
        case ELEMENT_NODE:

            if ((node.localName === 'appinfo' && node.namespaceURI === SCHEMA_NS) ||
                (node.localName === 'documentation'  && node.namespaceURI === WSDL_NS) ||
                (node.localName === 'documentation'  && node.namespaceURI === SCHEMA_NS) ||
                (node.localName === 'annotation'  && node.namespaceURI === SCHEMA_NS)) {
                node.parentNode.removeChild(node);
                node = null;  // no need to traverse deeper
            } else {
                let info = getNamespaceInfo(node.namespaceURI);
                if (info.known && (info.base || info.extension)) {
                    // Remove unnecessary attributes
                    if (node.attributes) {
                        for (let i = 0; i < node.attributes.length;) {
                            let attr = node.attributes[i];
                            let keep = false;
                            if (attr.nodeName && (attr.nodeName === 'xmlns' || attr.nodeName.startsWith('xmlns:'))) {
                                keep = true;
                            } else {
                                if (attr.namespaceURI) {
                                    let info = getNamespaceInfo(attr.namespaceURI);
                                    if (!info.known || (!info.base && !info.extension)) {
                                        attr = null;
                                    }
                                }
                                if (attr && ATTR_LOCAL_NAMES[attr.localName]) {
                                    keep = true;
                                }
                            }
                            if (keep) {
                                i++;
                            } else {
                                node.removeAttributeNode(node.attributes[i]);
                            }
                        }
                    }
                } else {
                    node.parentNode.removeChild(node);
                    node = null;
                }
            }
            break;
        default:

        }

        return node;
    });
}

const SCHEMA_NS = 'http://www.w3.org/2001/XMLSchema';
const WSDL_NS = 'http://schemas.xmlsoap.org/wsdl/';
const WSDL_SOAP11_NS = 'http://schemas.xmlsoap.org/wsdl/soap/';
const WSDL_SOAP12_NS = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const WSDL_HTTP_NS = 'http://schemas.xmlsoap.org/wsdl/http/';
const WSDL_MIME_NS = 'http://schemas.xmlsoap.org/wsdl/mime/';
const WS_ADDRESSING_NS = 'http://www.w3.org/2006/05/addressing/wsdl';

/**
* Remove all non-WSDL and non-XSD elements.
* Removing elements helps ensure that the node soap and other processors don't fail or produce bad data.
*
* Add apicID to schema elements.
* The apicID element is used to determine order of the elements, and in addition
* it forces an attribute onto each element which ensures that the 'undefined' key is set.
*/
function pruneAndAddID(dom, fileName, req) {
    fileName = fileName === 'MEMORY' ? 'file' : fileName;
    let id = 0;
    let map = {
        [SCHEMA_NS]: true,
        [WSDL_NS]: true,
        [WSDL_HTTP_NS]: true,
        [WSDL_SOAP11_NS]: true,
        [WSDL_SOAP12_NS]: true,
        [WSDL_MIME_NS]: true,
        [WS_ADDRESSING_NS]: true,
    };
    traverseDOM(dom, function(node, list) {
        if (node.nodeType === ELEMENT_NODE) {
            let info = getNameInfo(node.localName);
            if (map[node.namespaceURI]) {
                if (!info.common) {
                    // Looks like an attempt to use a name that is not defined in the standard
                    // Just ignore
                    throw g.http(u.r(req)).Error('The following name, %s, was bound to specification standard namespace %s.  This is an unrecognized element, please correct.',
                      node.nodeName, node.namespaceURI);
                } else if (node.namespaceURI === SCHEMA_NS) {
                    if (node.localName !== 'documentation') {
                        node.setAttribute('apicID', id++);
                    }
                }
            } else {
                // Discard this element
                if (info.common) {
                    if (node.nodeName.indexOf('binding') < 0) {
                        // If this is a common name, then someone may have mispelled a namespace.  Throw an error (unless it is a binding)
                        throw g.http(u.r(req)).Error('The following name, %s, was bound to namespace %s.  This is an unrecognized element, please correct.',
                            node.nodeName, node.namespaceURI);
                    }
                }
                node.parentNode.removeChild(node);
                node = null;
            }
        }
        return node;
    });
    return dom;
}

// Each namespace has the following information
//   known: indicates that we have seen this before and it is valid
//   base: means that it is an essential piece of XSD/WSDL
//   extension: means that it is an extension to wsdl or xsd that we actually process or checking (WS-SECURITY).
//              If known but not base/extension, this means that we recognize and ignore it.
//   for: text indicating how it is known.
const NAMESPACE_INFO = {
    'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd': {
        known: true,
        base: false,
        extension: true,
        for: 'WS-SECURITY'
    },
    'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd': {
        known: true,
        base: false,
        extension: true,
        for: 'WS-SECURITY'
    },
    'http://schemas.microsoft.com/ws/06/2004/mspolicy/netbinary1': {
        known: true,
        base: false,
        extension: false,
        for: 'Microsoft',
    },
    'http://schemas.microsoft.com/ws/06/2004/policy/http': {
        known: true,
        base: false,
        extension: false,
        for: 'Microsoft',
    },
    'http://schemas.microsoft.com/ws/2005/12/wsdl/contract': {
        known: true,
        base: false,
        extension: false,
        for: 'Microsoft',
    },
    'http://schemas.xmlsoap.org/ws/2004/09/policy': {
        known: true,
        base: false,
        extension: false,
        for: 'WS-Policy',
    },
    'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy': {
        known: true,
        base: false,
        extension: false,
        for: 'WS-Policy',
    },
    'http://schemas.xmlsoap.org/ws/2006/02/addressingidentity': {
        known: true,
        base: false,
        extension: false,
        for: 'WS-Addressing',
    },
    [WSDL_NS]: {
        known: true,
        base: true,
        extension: false,
        for: 'WSDL',
    },
    [WSDL_HTTP_NS]: {
        known: true,
        base: false,
        extension: true,  // This is for HTTP bindings in WSDL, which we currently ignore
        for: 'WSDL HTTP BINDING',
    },
    [WSDL_MIME_NS]: {
        known: true,
        base: false,
        extension: true,  // This is for MIME part scanning, we don't do anything special with mime
        for: 'WSDL MIME',
    },
    [WSDL_SOAP12_NS]: {
        known: true,
        base: true,
        extension: false,
        for: 'WSDL SOAP 1.2',
    },
    [WSDL_SOAP11_NS]: {
        known: true,
        base: true,
        extension: false,
        for: 'WSDL SOAP 1.1',
    },
    'http://ws-i.org/schemas/conformanceClaim/': {
        known: true,
        base: false,
        extension: true,  // Currently ignore this, but see https://github.ibm.com/velox/apiconnect-wsdl/issues/219
        for: 'WSDL WS-I',
    },
    'http://www.w3.org/2000/09/xmldsig#': {
        known: true,
        base: false,
        extension: false,
        for: 'WSDL WS-I',
    },
    [SCHEMA_NS]: {
        known: true,
        base: true,
        extension: false,
        for: 'XML Schema',
    },
    'http://www.w3.org/2005/05/xmlmime': {
        known: true,
        base: false,
        extension: true,  // This is for MIME part scanning, we don't do anything special with mime
        for: 'WSDL MIME',
    },
    'http://www.w3.org/2005/08/addressing': {
        known: true,
        base: false,
        extension: true,
        for: 'WS-Addressing',
    },
    [WS_ADDRESSING_NS]: {
        known: true,
        base: false,
        extension: true,
        for: 'WS-Addressing',
    },
    'http://www.w3.org/2007/XMLSchema-versioning': {
        known: true,
        base: false,
        extension: true,  // We currently only check and report if we find a versioning issue
        for: 'XML Schema 1.1',
    },
    'http://www.w3.org/XML/1998/namespace': {
        known: true,
        base: false,
        extension: true,
        for: 'XML Schema',
    },
    'http://java.sun.com/xml/ns/jaxws': {
        known: true,
        base: false,
        extension: false,
        for: 'JAXS GENERATION',
    },
    'http://schemas.xmlsoap.org/ws/2003/05/partner-link/': {
        known: true,
        base: false,
        extension: false,
        for: 'BPEL',
    },
    'http://www.w3.org/2001/12/soap-encoding': {
        known: true,
        base: false,
        extension: false,
        for: 'SOAP ENCODING'
    },
    'urn:un:unece:uncefact:documentation:standard:CoreComponentsTechnicalSpecification:2': {
        known: true,
        base: false,
        extension: false,
        for: 'United Nations ECE'
    },
    'http://lsdis.cs.uga.edu/projects/meteor-s/wsdl-s/': {
        known: true,
        base: false,
        extension: false,
        for: 'Web Service Semantics: WSDL-S'
    }
};

// Common NCNames for Nodes found in XSD or WSDL
var COMMOM_NODE_NAMES = [
    '#document', 'definitions', 'documentation', 'types', 'schema',
    'element', 'complexType', 'annotation', '#text', 'appinfo', 'sequence', 'message', 'part', 'portType',
    'operation', 'input', 'output', 'binding', 'body', 'service', 'port', 'address',
    '#comment', 'include', 'import', 'complexType', 'extension', 'restriction', 'simpleType',
    'simpleContent', 'complexContent', 'minLength', 'maxLength', 'pattern',
    'minInclusive', 'maxInclusive', 'attribute', 'group', 'attributeGroup',
    'totalDigits', 'enumeration', 'choice', '#cdata-section', 'any', 'anyAttribute',
    'list', 'fault', 'all', 'union', 'length', 'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive', 'fractionDigits',
    'header', 'whiteSpace', 'urlEncoded', 'redefine', 'notation', 'unique', 'headerfault', 'mimeXml', 'content', 'multipartRelated',
    'selector', 'field',
    'UsingAddressing',
    'key',
];

// Uncommon NCNames and the namspace they are usually associated with
var UNCOMMON_NODE_NAMES = {
    enableWrapperStyle: 'http://java.sun.com/xml/ns/jaxws',
    bindings: 'http://java.sun.com/xml/ns/jaxws',
    UsingPolicy: 'http://schemas.xmlsoap.org/ws/2004/09/policy',
    PolicyReference: 'http://schemas.xmlsoap.org/ws/2004/09/policy',
    Policy: 'http://schemas.xmlsoap.org/ws/2004/09/policy',
    ExactlyOne: 'http://schemas.xmlsoap.org/ws/2004/09/policy',
    All: 'http://schemas.xmlsoap.org/ws/2004/09/policy',
    TransportBinding: 'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy',
    TransportToken: 'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy',
    HttpsToken: 'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy',
    AlgorithmSuite: 'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy',
    Layout: 'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy',
    Basic256: 'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy',
    Strict: 'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy',
    UsernameToken: 'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy',
    SupportingTokens: 'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy',
    WssUsernameToken10: 'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy',
    EndpointReference: 'http://www.w3.org/2005/08/addressing',
    Address: 'http://www.w3.org/2005/08/addressing',
    Identity: 'http://schemas.xmlsoap.org/ws/2006/02/addressingidentity',
    Spn: 'http://schemas.xmlsoap.org/ws/2006/02/addressingidentity',
    NegotiateAuthentication: 'http://schemas.microsoft.com/ws/06/2004/policy/http',
    BbinaryAuthentication: 'http://schemas.microsoft.com/ws/06/2004/policy/http',
    BasicAuthentication: 'http://schemas.microsoft.com/ws/06/2004/policy/http',
    BinaryEncoding: 'http://schemas.microsoft.com/ws/06/2004/mspolicy/netbinary1',
    role: 'http://schemas.xmlsoap.org/ws/2003/05/partner-link/',
    partnerLinkType: 'http://schemas.xmlsoap.org/ws/2003/05/partner-link/',
    Acronym: 'urn:un:unece:uncefact:documentation:standard:CoreComponentsTechnicalSpecification:2',
    DictionaryEntryName: 'urn:un:unece:uncefact:documentation:standard:CoreComponentsTechnicalSpecification:2',
    Version: 'urn:un:unece:uncefact:documentation:standard:CoreComponentsTechnicalSpecification:2',
    Definition: 'urn:un:unece:uncefact:documentation:standard:CoreComponentsTechnicalSpecification:2',
    PrimaryRepresentationTerm: 'urn:un:unece:uncefact:documentation:standard:CoreComponentsTechnicalSpecification:2',
    PrimitiveType: 'urn:un:unece:uncefact:documentation:standard:CoreComponentsTechnicalSpecification:2',
    PropertyTerm: 'urn:un:unece:uncefact:documentation:standard:CoreComponentsTechnicalSpecification:2',
    UsageRule: 'urn:un:unece:uncefact:documentation:standard:CoreComponentsTechnicalSpecification:2',
    ObjectClassTerm: 'urn:un:unece:uncefact:documentation:standard:CoreComponentsTechnicalSpecification:2',
    Name: 'urn:un:unece:uncefact:documentation:standard:CoreComponentsTechnicalSpecification:2',
    UniqueID: 'urn:un:unece:uncefact:documentation:standard:CoreComponentsTechnicalSpecification:2',
    category: 'http://lsdis.cs.uga.edu/projects/meteor-s/wsdl-s/'

};

// These attribute local names might be processed by API Connect WSDL and are retained in a sanitized WSDL
var ATTR_LOCAL_NAMES = {
    abstract: true,
    Action: true,
    arrayType: true,
    attributeFormDefault: true,
    base: true,
    binding: true,
    block: true,
    blockDefault: true,
    default: true,
    element: true,
    elementFormDefault: true,
    encodingStyle: true,
    expectedContentTypes: true,
    final: true,
    finalDefault: true,
    fixed: true,
    form: true,
    id: true,
    itemType: true,
    lang: true,
    location: true,
    maxOccurs: true,
    maxVersion: true,
    memberTypes: true,
    message: true,
    minOccurs: true,
    minVersion: true,
    mixed: true,
    name: true,
    namespace: true,
    nillable: true,
    parameterOrder: true,
    part: true,
    parts: true,
    processContents: true,
    public: true,
    ref: true,
    refer: true,
    required: true,
    Required: true,
    schemaLocation: true,
    soapAction: true,
    soapActionRequired: true,
    source: true,
    style: true,
    substitutionGroup: true,
    system: true,
    targetNamespace: true,
    transport: true,
    type: true,
    use: true,
    value: true,
    verb: true,
    version: true,
    xmlns: true,
    xpath: true
};

// Common NCNames for attributes found in xsd and wsdl files
var COMMOM_ATTR_NAMES = [
    'name', 'targetNamespace', 'xmlns', 'type', 'lang', 'source',
    'minOccurs', 'maxOccurs', 'element', 'message', 'style', 'transport', 'soapAction', 'soapActionRequired',
    'use', 'binding', 'location', 'elementFormDefault', 'attributeFormDefault', 'mixed', 'ref',
    'base', 'value', 'fixed', 'default', 'version', 'schemaLocation', 'substitutionGroup',
    'namespace', 'nillable', 'id', 'abstract', 'processContents', 'final', 'itemType', 'Action',
    'memberTypes', 'parts', 'parameterOrder', 'part', 'block', 'blockDefault', 'encodingStyle', 'finalDefault', 'xpath', 'refer',
    'form', 'verb', 'expectedContentTypes', 'minVersion', 'maxVersion', 'public', 'system',
    'apicID', // This is an attribute silently added by APIC during processing so that we can track order
    'required',
    'Required'  // A wsdl:required is set on extensions elements to indicate if they are required for communication.  I have seen Required also used.
];

// Uncommon  Attribute NCNames and the namspace they are usually associated with
var UNCOMMON_ATTR_NAMES = {
    docRoot: 'an ibm tooling extension',
    Id: 'http://schemas.xmlsoap.org/ws/2004/09/policy',
    URI: 'http://schemas.xmlsoap.org/ws/2004/09/policy',
    RequireClientCertificate: 'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy',
    IncludeToken: 'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy',
    usingSession: 'http://schemas.microsoft.com/ws/2005/12/wsdl/contract',
    arrayType: 'http://www.w3.org/2001/12/soap-encoding', // Actually in 'http://schemas.xmlsoap.org/wsdl/' but used for soap encoding
    taxonomyURI: 'http://lsdis.cs.uga.edu/projects/meteor-s/wsdl-s/'
};

// NODE TYPE INFORMATION
var NODE_TYPE = {
    1: { keep: true,   report: false, name: 'ELEMENT_NODE' },
    2: { keep: true,   report: false, name: 'ATTRIBUTE_NODE' },
    3: { keep: true,   report: false, name: 'TEXT_NODE' },
    4: { keep: true,   report: false, name: 'CDATA_SECTION_NODE' },
    5: { keep: false,  report: true,  name: 'ENTITY_REFERENCE_NODE' },
    6: { keep: false,  report: true,  name: 'ENTITY_NODE' },
    7: { keep: true,   report: false, name: 'PROCESSING_INSTRUCTION_NODE' },
    8: { keep: false,  report: false, name: 'COMMENT_NODE' },
    9: { keep: true,   report: false, name: 'DOCUMENT_NODE' },
    10: { keep: false, report: true,  name: 'DOCUMENT_TYPE_NODE' },
    11: { keep: true,  report: true,  name: 'DOCUMENT_FRAGMENT_NODE' },
    12: { keep: true,  report: true,  name: 'NOTATION_NODE' }
};
const   ELEMENT_NODE = 1,
        ATTRIBUTE_NODE = 2,
        TEXT_NODE = 3,
        CDATA_SECTION_NODE = 4,
        ENTITY_REFERENCE_NODE = 5,
        ENTITY_NODE = 6,
        PROCESSING_INSTRUCTION_NODE = 7,
        COMMENT_NODE = 8,
        DOCUMENT_NODE = 9,
        DOCUMENT_TYPE_NODE = 10,
        DOCUMENT_FRAGMENT_NODE = 11,
        NOTATION_NODE = 12;


// wraps all documentation in CDATA sections - allows random XML content to
// exist in the doc so that the parser doesn't barf on it
function protectDocumentation(contents) {
    var ret = '';
    if (contents) {
        if (contents.toString) {
            contents = contents.toString();
        }

        // Find the raw references to documentation elements in the contents
        // and add them to the elementList
        var elementList = [];
        var regex = /documentation>/gi;
        var result;
        while ((result = regex.exec(contents))) {
            var idx = result.index - 1;
            var prepend = '';
            while (contents[idx] != '<' &&
             contents[idx] != '/') {
                prepend = contents[idx] + prepend;
                idx--;
            }
            var name = prepend + 'documentation';
            if (elementList.indexOf(name) < 0) {
                elementList.push(name);
            }
        }

        // For each elementList item, call protectDocSpecific which
        // will wrap the contents of those elements in CDATA
        var len = elementList.length;
        ret = contents;
        for (var i = 0; i < len; i++) {
            var elementName = elementList[i];
            ret = protectDocSpecific(ret, elementName);
        } // end for
    }
    return ret;
}

/**
* Wrap the indicated elementName in a CDATA
*/
function protectDocSpecific(contents, elementName) {
    var ret = '';
    var index = 0;
    var offset = 0;
    var len = contents.length;
    var elementStart = '<' + elementName;
    var elementEnd = '</' + elementName;
    while (offset < len) {
        index = contents.indexOf(elementStart, offset);
        if (index === -1) {
            ret += contents.substring(offset);
            break;
        } else {
            let endStart = contents.indexOf('>', index);
            let endStartEnd = contents.indexOf('/>', index);
            if (endStartEnd > 0 && endStartEnd < endStart) {
                // <xs:documentation />
                ret += contents.substring(offset, endStart + 1);
                offset = endStart + 1;
            } else {
                // <xs:documentation >
                // <xs:documentation >
                ret += contents.substring(offset, endStart + 1);
                var endIndex = contents.indexOf(elementEnd, endStart);
                let endEnd = contents.indexOf('>', endIndex);
                var doc = contents.substring(endStart + 1, endIndex);
                // put doc in CDATA if not done already
                var trimmed = doc.trim();
                if (trimmed.indexOf('<![CDATA[') != -1) {
                    // remove any nested CDATA and wrap with ours
                    doc = trimmed.replace(/]]>/g, '');
                    doc = doc.replace(/<!\[CDATA\[/g, '');
                    doc = '<![CDATA[' + doc + ']]>';
                    ret += doc;
                } else if (doc.indexOf('<') < 0 && doc.indexOf('>') < 0) {
                    // If no element start or end token, then don't bother wrapping in CDATA
                    ret += doc;
                } else {
                    doc = '<![CDATA[' + doc + ']]>';
                    ret += doc;
                }
                ret += contents.substring(endIndex, endEnd + 1);
                offset = endEnd + 1;
            }
        }
    } // end for
    return ret;
}

// Each token (key) must have a parent in the list (value)
const PARENT = {
    // Schema parents
    '<xsd_schema>': [ 'document', '<wsdl_types>' ],
    '<xsd_include>': [ '<xsd_schema>' ],
    '<xsd_import>': [ '<xsd_schema>' ],
    '<xsd_redefine>': [ '<xsd_schema>' ],
    '<xsd_appinfo>': [ '<xsd_annotation>' ],
    '<xsd_documentation>': [ '<xsd_annotation>' ],
    '<xsd_simpleType>': [ '<xsd_schema>', '<xsd_redefine>', '<xsd_attribute>', '<xsd_element>', '<xsd_restriction>', '<xsd_union>', '<xsd_list>' ],
    '<xsd_complexType>': [ '<xsd_schema>', '<xsd_redefine>', '<xsd_element>' ],
    '<xsd_group>': [ '<xsd_schema>', '<xsd_redefine>', '<xsd_sequence>', '<xsd_choice>', '<xsd_complexType>', '<xsd_restriction>', '<xsd_extension>' ],
    '<xsd_sequence>': [ '<xsd_group>', '<xsd_sequence>', '<xsd_choice>', '<xsd_complexType>', '<xsd_restriction>', '<xsd_extension>' ],
    '<xsd_choice>': [ '<xsd_group>', '<xsd_sequence>', '<xsd_choice>', '<xsd_complexType>', '<xsd_restriction>', '<xsd_extension>' ],
    '<xsd_all>': [ '<xsd_group>', '<xsd_complexType>', '<xsd_restriction>', '<xsd_extension>' ],
    '<xsd_any>': [ '<xsd_choice>', '<xsd_sequence>' ],
    '<xsd_attributeGroup>': [ '<xsd_schema>', '<xsd_redefine>', '<xsd_attributeGroup>', '<xsd_complexType>', '<xsd_restriction>', '<xsd_extension>' ],
    '<xsd_anyAttribute>': [ '<xsd_attributeGroup>', '<xsd_complexType>', '<xsd_restriction>', '<xsd_extension>' ],
    '<xsd_attribute>': [ '<xsd_schema>', '<xsd_attributeGroup>', '<xsd_complexType>', '<xsd_restriction>', '<xsd_extension>' ],
    '<xsd_element>': [ '<xsd_schema>', '<xsd_group>', '<xsd_sequence>', '<xsd_choice>', '<xsd_all>' ],
    '<xsd_complexContent>': [ '<xsd_complexType>' ],
    '<xsd_simpleContent>': [ '<xsd_complexType>' ],
    '<xsd_extension>': [ '<xsd_simpleContent>', '<xsd_complexContent>' ],
    '<xsd_restriction>': [ '<xsd_simpleType>', '<xsd_simpleContent>', '<xsd_complexContent>' ],
    '<xsd_enumeration>': [ '<xsd_restriction>' ],
    '<xsd_fractionDigits>': [ '<xsd_restriction>' ],
    '<xsd_totalDigits>': [ '<xsd_restriction>' ],
    '<xsd_length>': [ '<xsd_restriction>' ],
    '<xsd_minInclusive>': [ '<xsd_restriction>' ],
    '<xsd_maxInclusive>': [ '<xsd_restriction>' ],
    '<xsd_minExclusive>': [ '<xsd_restriction>' ],
    '<xsd_maxExInclusive>': [ '<xsd_restriction>' ],
    '<xsd_minLength>': [ '<xsd_restriction>' ],
    '<xsd_maxLength>': [ '<xsd_restriction>' ],
    '<xsd_pattern>': [ '<xsd_restriction>' ],
    '<xsd_whiteSpace>': [ '<xsd_restriction>' ],
    '<xsd_field>': [ '<xsd_key>', '<xsd_keyref>', '<xsd_unique>' ],
    '<xsd_selector>': [ '<xsd_key>', '<xsd_keyref>', '<xsd_unique>' ],
    '<xsd_key>': [ '<xsd_element>' ],
    '<xsd_keyref>': [ '<xsd_element>' ],
    '<xsd_unique>': [ '<xsd_element>' ],
    '<xsd_list>': [ '<xsd_simpleType>' ],
    '<xsd_notation>': [ '<xsd_schema>' ],
    '<xsd_union>': [ '<xsd_simpleType>' ],

    // WSDL
    '<wsdl_definitions>': [ 'document' ],
    '<wsdl_import>': [ '<wsdl_definitions>' ],
    // '<wsdl_documentation>': [ all wsdl ],
    '<wsdl_types>': [ '<wsdl_definitions>' ],
    '<wsdl_message>': [ '<wsdl_definitions>' ],
    '<wsdl_part>': [ '<wsdl_message>' ],
    '<wsdl_portType>': [ '<wsdl_definitions>' ],
    '<wsdl_binding>': [ '<wsdl_definitions>' ],
    '<wsdl_service>': [ '<wsdl_definitions>' ],
    '<wsdl_port>': [ '<wsdl_service>' ],
    '<wsdl_operation>': [ '<wsdl_portType>', '<wsdl_binding>' ],
    '<wsdl_input>': [ '<wsdl_operation>' ],
    '<wsdl_output>': [ '<wsdl_operation>' ],
    '<wsdl_fault>': [ '<wsdl_operation>' ],

    // SOAP Extension
    '<soap_binding>': [ '<wsdl_binding>' ],
    '<soap_operation>': [ '<wsdl_operation>' ],
    '<soap_body>': [ '<wsdl_input>', '<wsdl_output>', '<mime_part>' ],
    '<soap_header>': [ '<wsdl_input>', '<wsdl_output>', '<wsdl_fault>', '<mime_part>' ],
    '<soap_headerfault>': [ '<soap_header>' ],
    '<soap_fault>': [ '<wsdl_fault>' ],
    '<soap_address>': [ '<wsdl_port>' ],

    // MIME extension
    // Specification is not clear on mime usage on fault , so I am choosing to accept it.
    '<mime_multipartRelated>': [ '<wsdl_input>', '<wsdl_output>', '<wsdl_fault>' ],
    '<mime_content>': [ '<mime_part>', '<wsdl_input>', '<wsdl_output>', '<wsdl_fault>' ],
    '<mime_mimeXml>': [ '<mime_part>', '<wsdl_input>', '<wsdl_output>', '<wsdl_fault>' ],
    '<mime_part>': [ '<mime_multipartRelated>' ],

};
// Each token (key) must child tokens described by the regexp (value)
const CHILDREN = {
    // Schema
    '<xsd_schema>': /^((<xsd_include>|<xsd_import>|<xsd_redefine>|<xsd_annotation>)*(<xsd_simpleType>|<xsd_complexType>|<xsd_group>|<xsd_attributeGroup>|<xsd_element>|<xsd_attribute>|<xsd_notation>|<xsd_annotation>)*)$/,
    '<xsd_include>': /^(<xsd_annotation>)?$/,
    '<xsd_import>': /^(<xsd_annotation>)?$/,
    '<xsd_redefine>': /^(<xsd_simpleType>|<xsd_complexType>|<xsd_group>|<xsd_attributeGroup>|<xsd_annotation>)*$/,
    '<xsd_annotation>': /^(<xsd_appinfo>|<xsd_documentation>)*$/,
    '<xsd_simpleType>': /^(<xsd_annotation>)?(<xsd_restriction>|<xsd_list>|<xsd_union>)$/,
    '<xsd_complexType>': /^(<xsd_annotation>)?(<xsd_simpleContent>|<xsd_complexContent>|(<xsd_sequence>|<xsd_group>|<xsd_all>|<xsd_choice>)?((<xsd_attribute>|<xsd_attributeGroup>)*(<xsd_anyAttribute>)?))$/,
    '<xsd_group>': /^(<xsd_annotation>)?(<xsd_all>|<xsd_choice>|<xsd_sequence>)?$/,
    '<xsd_sequence>': /^(<xsd_annotation>)?(<xsd_element>|<xsd_sequence>|<xsd_group>|<xsd_choice>|<xsd_any>)*$/,
    '<xsd_choice>': /^(<xsd_annotation>)?(<xsd_element>|<xsd_sequence>|<xsd_group>|<xsd_choice>|<xsd_any>)*$/,
    '<xsd_all>': /^(<xsd_annotation>)?(<xsd_element>)*$/,
    '<xsd_any>': /^(<xsd_annotation>)?$/,
    '<xsd_attributeGroup>': /^(<xsd_annotation>)?(<xsd_attributeGroup>|<xsd_attribute>)*(<xsd_anyAttribute>)?$/,
    '<xsd_anyAttribute>': /^(<xsd_annotation>)?$/,
    '<xsd_attribute>': /^(<xsd_annotation>)?(<xsd_simpleType>)?$/,
    '<xsd_element>': /^(<xsd_annotation>)?(<xsd_simpleType>|<xsd_complexType>)?(<xsd_unique>|<xsd_key>|<xsd_keyref>)*$/,
    '<xsd_complexContent>': /^(<xsd_annotation>)?(<xsd_extension>|<xsd_restriction>)$/,
    '<xsd_simpleContent>': /^(<xsd_annotation>)?(<xsd_extension>|<xsd_restriction>)$/,
    '<xsd_extension>': /^(<xsd_annotation>)?(<xsd_all>|<xsd_sequence>|<xsd_group>|<xsd_choice>)?(<xsd_attributeGroup>|<xsd_attribute>)*(<xsd_anyAttribute>)?$/,
    '<xsd_simpleContent><xsd_restriction>': /^(<xsd_annotation>)?(<xsd_simpleType>)?(<xsd_minExclusive>|<xsd_maxExclusive>|<xsd_minInclusive>|<xsd_maxInclusive>|<xsd_totalDigits>|<xsd_fractionDigits>|<xsd_length>|<xsd_minLength>|<xsd_maxLength>|<xsd_whiteSpace>|<xsd_enumeration>|<xsd_pattern>)*(<xsd_attributeGroup>|<xsd_attribute>)*(<xsd_anyAttribute>)?$/,
    '<xsd_simpleType><xsd_restriction>': /^(<xsd_annotation>)?(<xsd_simpleType>)?(<xsd_minExclusive>|<xsd_maxExclusive>|<xsd_minInclusive>|<xsd_maxInclusive>|<xsd_totalDigits>|<xsd_fractionDigits>|<xsd_length>|<xsd_minLength>|<xsd_maxLength>|<xsd_whiteSpace>|<xsd_enumeration>|<xsd_pattern>)*$/,
    '<xsd_complexContent><xsd_restriction>': /^(<xsd_annotation>)?(<xsd_all>|<xsd_sequence>|<xsd_group>|<xsd_choice>)?(<xsd_attributeGroup>|<xsd_attribute>)*(<xsd_anyAttribute>)?$/,
    '<xsd_enumeration>': /^(<xsd_annotation>)?$/,
    '<xsd_fractionDigits>': /^(<xsd_annotation>)?$/,
    '<xsd_totalDigits>': /^(<xsd_annotation>)?$/,
    '<xsd_length>': /^(<xsd_annotation>)?$/,
    '<xsd_minInclusive>': /^(<xsd_annotation>)?$/,
    '<xsd_maxInclusive>': /^(<xsd_annotation>)?$/,
    '<xsd_minExclusive>': /^(<xsd_annotation>)?$/,
    '<xsd_maxExInclusive>': /^(<xsd_annotation>)?$/,
    '<xsd_minLength>': /^(<xsd_annotation>)?$/,
    '<xsd_maxLength>': /^(<xsd_annotation>)?$/,
    '<xsd_pattern>': /^(<xsd_annotation>)?$/,
    '<xsd_whiteSpace>': /^(<xsd_annotation>)?$/,
    '<xsd_field>': /^(<xsd_annotation>)?$/,
    '<xsd_selector>': /^(<xsd_annotation>)?$/,
    '<xsd_key>': /^(<xsd_annotation>)?(<xsd_selector>(<xsd_field>)+)$/,
    '<xsd_keyref>': /^(<xsd_annotation>)?(<xsd_selector>(<xsd_field>)+)$/,
    '<xsd_list>': /^(<xsd_annotation>)?(<xsd_simpleType>)?$/,
    '<xsd_notation>': /^(<xsd_annotation>)?$/,
    '<xsd_union>': /^(<xsd_annotation>)?(<xsd_simpleType>)*$/,
    '<xsd_unique>': /^(<xsd_annotation>)?(<xsd_selector>(<xsd_field>)+)$/,

    // WSDL
    '<wsdl_definitions>': /^(<xsd_annotation>)?(<wsdl_documentation>)?(<wsdl_import>)*(<wsdl_documentation>)?(<wsdl_types>)?(<wsdl_message>|<wsdl_portType>|<wsdl_binding>|<wsdl_service>)*$/,
    '<wsdl_import>': /^(<xsd_annotation>)?$/,
    '<wsdl_types>': /^(<wsdl_documentation>)?(<xsd_schema>)*$/,
    '<wsdl_message>': /^(<wsdl_documentation>)?(<wsdl_part>)*$/,
    '<wsdl_part>': /^(<wsdl_documentation>)?$/,
    '<wsdl_portType>': /^(<wsdl_documentation>)?(<wsdl_operation>)*$/,
    '<wsdl_binding>': /^(<wsdl_documentation>)?(<soap_binding>)?(<wsdl_operation>)*$/,
    '<wsdl_service>': /^(<wsdl_documentation>)?(<wsdl_port>)*$/,
    '<wsdl_port>': /^(<wsdl_documentation>)?(<soap_address>)?$/,
    '<wsdl_operation>': /^(<wsdl_documentation>)?(<soap_operation>)?(<wsdl_input>)?(<wsdl_output>)?(<wsdl_fault>)*$/,
    // Allow wsdl soap header elements before or after wsdl soap body
    '<wsdl_input>': /^(<wsdl_documentation>)?(<mime_multipartRelated>|<mime_content>|<mime_mimeXml>|((<soap_header>)*(<soap_body>)?(<soap_header>)*))$/,
    '<wsdl_output>': /^(<wsdl_documentation>)?(<mime_multipartRelated>|<mime_content>|<mime_mimeXml>|((<soap_header>)*(<soap_body>)?(<soap_header>)*))$/,

    // Allow soap_header on wsdl_fault...this is a hole in the spec
    // Specification is unclear about mime on wsdl_fault, so choosing to accept it.
    '<wsdl_fault>': /^(<wsdl_documentation>)?(<mime_multipartRelated>|<mime_content>|<mime_mimeXml>|((<soap_header>)*(<soap_fault>)?(<soap_header>)*))$/,

    // SOAP Extension
    '<soap_binding>': /^$/,
    '<soap_operation>': /^$/,
    '<soap_body>': /^$/,
    '<soap_header>': /^(<soap_headerfault>)*$/,
    '<soap_headerfault>': /^$/,
    '<soap_fault>': /^$/,
    '<soap_address>': /^$/,

    // MIME Extension
    '<mime_part>': /^(<wsdl_documentation>)?(<mime_multipartRelated>|<mime_content>|<mime_mimeXml>|((<soap_header>)*(<soap_body>)?(<soap_header>)*))$/,
    '<mime_multipartRelated>': /^(<mime_part>)*$/,
    '<mime_content>': /^$/,
    '<mime_mimeXml>': /^$/,
};

// Poorly ordered or duplicate annotation is ignored.
// Set the fields to false to enable stricter validation
const LAX = {
    '<wsdl_documentation>': true,
    '<xsd_annotation>': true,
    '<xsd_appinfo>': true,
    '<xsd_documentation>': true,
};

/**
* Check the dom for valid wsdl, xsd, soap extensions and mime extensions.
* This is done to prevent garbage from leaking to the backend.
* Garbage files can cause abends leading to denail of service.
* Garbage files can also set a precedent for API Connect supporting invalid files.
* @TODO The checker could be improved to process attributes too.
**/
function syntaxCheck(dom, fileName, req) {
    // A wsdl:binding contains either a soap 1.1 or soap 1.2 binding.
    // getToken will ensure that other nested soap elements (like soap 1.1 or soap 1.2 operations)
    // have the same extension as the binding.
    let soapBindingNS = null;
    traverseDOM(dom, function(node) {
        let token = getToken(node, req, fileName, soapBindingNS);
        if (token == '<wsdl_binding>' || token == '<wsdl_service>') {
            soapBindingNS = null;
        } else if (token == '<soap_binding>') {
            soapBindingNS = node.namespaceURI;
        }
        const parents = PARENT[token];
        if (parents) {
            let parentToken = getToken(node.parentNode, req, fileName, null);
            if (parents.indexOf(parentToken) < 0) {
                let msg = g.http(u.r(req)).f('Expected %s %s to have parent of %s but found %s. This invalid syntax was found in file %s.', token, getTokenName(node), parents, parentToken, fileName);
                // Mime syntax is a bit loose, so embed an error versus throwing a fatal error
                if (msg.includes('mime')) {
                    R.error(req, msg);
                }  else {
                    throw new Error(msg);
                }
            }
            let regexp = CHILDREN[token] || CHILDREN[parentToken + token];
            let childTokens = '';
            if (regexp) {
                childTokens = getChildTokens(node, req, fileName, soapBindingNS);
                if (!regexp.test(childTokens)) {
                    let msg = g.http(u.r(req)).f('Expected %s %s to have children %s but found %s. This invalid syntax was found in file %s.', token, getTokenName(node), regexp, childTokens, fileName);
                    // Mime syntax is a bit loose, so embed an error versus throwing a fatal error
                    if (msg.includes('mime')) {
                        R.error(req, msg);
                    }  else {
                        throw new Error(msg);
                    }
                }
            }
            if (token === '<xsd_restriction>') {
                let facets = [ 'length', 'pattern', 'totalDigits', 'fractionDigits', 'whiteSpace',
                    'minLength', 'maxLength', 'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive' ];

                for (let i = 0; i < facets.length; i++) {
                    let r = new RegExp('/' + facets[i] + '/g');
                    let count = (childTokens.match(r) || []).length;
                    if (count > 1) {
                        let msg = g.http(u.r(req)).f('Found %s occurrences of facet %s. This invalid syntax was found in file %s.', count,  facets[i], fileName);
                        throw new Error(msg);
                    }
                }
            }
        }
        return node;
    });
}

/**
* Create a string 'token' representing this dom element.
* The token is used by the regexp code in syntaxChecker to verify wsdl, xsd, soap, mime
**/
function getToken(node, req, fileName, soapBindingNS) {
    let token = '';
    if (!node) {
        return token;
    }
    if (node.nodeType === DOCUMENT_NODE) {
        token = 'document';
    } else if (node.nodeType === ELEMENT_NODE) {
        if (node.namespaceURI === SCHEMA_NS) {
            token = '<xsd_' + node.localName + '>';
        } else if (node.namespaceURI === WSDL_NS) {
            token = '<wsdl_' + node.localName + '>';
        } else if (node.namespaceURI === WSDL_SOAP11_NS || node.namespaceURI === WSDL_SOAP12_NS) {
            token = '<soap_' + node.localName + '>';
            if (soapBindingNS && soapBindingNS !==  node.namespaceURI) {
                let msg = g.http(u.r(req)).f('Found a SOAP namespace of \'%s\' on element \'%s\' which does not match the SOAP binding namespace \'%s\'. The invalid syntax was found in file %s.', node.namespaceURI, node.localName, soapBindingNS, fileName);
                R.error(req, msg);
            }
        } else if (node.namespaceURI === WSDL_MIME_NS) {
            token = '<mime_' + node.localName + '>';
        }
        if (LAX[token]) {
            token = '';
        }
    } else if (node.nodeType === TEXT_NODE) {
        let data = node.data.trim();
        if (data) {
            token = 'TEXT(' + data + ')';
        }
    }
    return token;
}

function getTokenName(node) {
    if (!node) {
        return '';
    }
    return node.getAttribute('name') || node.getAttribute('targetNamespace') || node.getAttribute('namespace') || node.getAttribute('ref');
}

/**
* Create a string 'token' representing this node's children
* The token is used by the regexp code in syntaxChecker to verify wsdl, xsd, soap, mime
**/
function getChildTokens(node, req, fileName, soapBindingNS) {
    let str = '';
    for (let i = 0; i < node.childNodes.length; i++) {
        str += getToken(node.childNodes[i], req, fileName, soapBindingNS);
    }
    return str;
}

exports.loadSafeDOM = loadSafeDOM;
exports.getAttrInfo = getAttrInfo;
exports.getLocations = getLocations;
exports.getNamespaceInfo = getNamespaceInfo;
exports.getNamesMap = getNamesMap;
exports.getNameInfo = getNameInfo;
exports.getNodeTypeInfo = getNodeTypeInfo;
exports.getKnownNamespaces = getKnownNamespaces;
exports.hasSchemaRef = hasSchemaRef;
exports.promoteNamespaceDeclarations = promoteNamespaceDeclarations;
exports.protectDocumentation = protectDocumentation;
exports.pruneAndAddID = pruneAndAddID;
exports.removeDTD = removeDTD;
exports.removeXSDImportsAndIncludes = removeXSDImportsAndIncludes;
exports.sanitizeDOM = sanitizeDOM;
exports.serializeDOM = serializeDOM;
exports.syntaxCheck = syntaxCheck;
exports.traverseDOM = traverseDOM;
