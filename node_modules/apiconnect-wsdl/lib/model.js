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
const d = require('../lib/domUtils.js');
const u = require('../lib/utils.js');
const g = require('../lib/strong-globalize-fake.js');
const ELEMENT_NODE = 1;
const NAMESPACE_URI = 'http://www.w3.org/2000/xmlns/';
const WSDL_NS = 'http://schemas.xmlsoap.org/wsdl/';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/**
* Create a model from a dom.
* The dom was built from a wsdl or schema file.
*
* model.json is a lightweight representation of the dom
*   - each element in the dom is a property on the model.json
*   - namespace declarations are collected on local and global objects
*   - each attribute of an element is defined on a property named 'undefined'
*   For example a wsdl is represented as:
*      model.json.definitions
*                            .undefined: {targetNamespace='foo}
*                            .types: [...]
*                            .messages: [...]
*                            .portType: [...]
*                            .binding: [...]
*                            .services: [...]
* The model.json representation is similar to the one created by node.soap.
* In addition, other properties are added to help with subsequent generation.
*
* If this is a dom for a wsdl then
*   - model.namespaces contains the global namespaces
*   - model.serviceJSON contains the services json object (if services were found in this dom)
* @param dom
* @return model
*/
function dom2Model(dom, fileName, req) {
    let model = { json: {} };
    let stack = [];
    let xmlnsGlobal = {};
    let xmlnsLocal = {};
    stack.push(model.json);

    /**
    * pre:
    * called for each node in the dom tree during traversal when
    * the node is first encountered (i.e. start tag of the element)
    **/
    function pre(node) {
        let curr = stack[stack.length - 1];
        // Only ELEMENT nodes are processed
        if (node.nodeType === ELEMENT_NODE) {
            // Create an json object (obj) for this elements
            let local = node.localName;
            let obj = {};

            // If this is a schema element or first-level wsdl element,
            // then create an namespace map (xmlns) for local namespaces.
            if (model.json.definitions && (stack.length === 2 || local === 'schema')) {
                obj.xmlns = {};
                xmlnsLocal = obj.xmlns;
            }

            // Walk the attributes of the element.
            // - Namespace declarations are added to the local and global maps.
            // - All other elements are added as properties on the 'undefined' object
            if (node.attributes && node.attributes.length > 0) {
                for (let i = 0; i < node.attributes.length; i++) {
                    let attr = node.attributes[i];
                    if (attr.namespaceURI === NAMESPACE_URI) {
                        // This is a namespace declaration
                        if (attr.name !== 'xmlns') {
                            let prefix = _.split(attr.name, ':')[1];
                            if (xmlnsLocal) {
                                if (xmlnsLocal[prefix] === undefined) {
                                    xmlnsLocal[prefix] = attr.nodeValue;
                                } else if (xmlnsLocal[prefix] !== attr.nodeValue) {
                                    throw g.http(u.r(req)).Error('Internal Error: Redefinition of local prefix (%s): values(%s, %s) in %s',
                                          prefix, xmlnsLocal[prefix], attr.nodeValue, fileName);
                                }
                            }
                            if (xmlnsGlobal[prefix] === undefined) {
                                xmlnsGlobal[prefix] = attr.nodeValue;
                            } else if (xmlnsGlobal[prefix] !== attr.nodeValue) {
                                if (model.json.schema) {
                                    throw g.http(u.r(req)).Error('Internal Error: Redefinition of global prefix (%s): values(%s, %s) in %s',
                                      prefix, xmlnsGlobal[prefix], attr.nodeValue, fileName);
                                }
                            }
                        }
                    } else {
                        // Not a namespace declaration
                        let name = specialNamespace(attr.namespaceURI) ? attr.name : attr.localName;
                        obj['undefined'] = obj['undefined'] || {};
                        obj['undefined'][name] = attr.nodeValue;
                    }
                }
            }

            // The targetNamespace of the top-level wsdl definitions or schema element
            // is also placed in the local and global map with the special prefix '__tns__'
            if (stack.length === 1 || local === 'schema') {
                let tgtNS = node.getAttribute('targetNamespace');
                if (tgtNS) {
                    xmlnsGlobal['__tns__'] = xmlnsGlobal['__tns__'] || tgtNS;
                    if (xmlnsLocal) {
                        xmlnsLocal['__tns__'] = xmlnsLocal['__tns__'] || tgtNS;
                    }
                } else {
                    obj['undefined'] = obj['undefined'] || {};
                    obj['undefined'].targetNamespace = '';
                }
            }

            // If this is a documentation element, assign its text
            if (node.localName === 'documentation') {
                let text = getText(node) || null;
                if (obj['undefined']) {
                    if (text) {
                        obj['$value'] = text;
                    }
                } else {
                    obj = text;
                }
            }

            // Now add the obj to its parent using the name (local name).
            // If there are multiple elements of the same name, an array is used.
            // Push the object on the stack (the code will now traverse into the child elements).
            if (!curr[local]) {
                curr[local] = obj;
            } else {
                curr[local] = u.makeSureItsAnArray(curr[local]);
                curr[local].push(obj);
            }
            stack.push(obj);
        }
        return node;
    }
    /**
    * post:
    * called for each node in the dom tree during traversal when
    * the node is last encountered (i.e. end tag of the element)
    **/
    function post(node) {
        if (node.nodeType === 1) {
            // Done processing the object, so it is popped off of the stack
            let obj = stack.pop();
            if (_.isObject(obj)) {
                // If the object is not empty, annotate it with its full name.
                // If the object is empty, it will be replaced with null.
                if (!_.isEmpty(obj)) {
                    obj['undefined'] = obj['undefined'] || {};
                    obj['undefined'].__name__ = node.nodeName;
                    if (node.localName === 'binding' || node.localName === 'address') {
                        obj['undefined'].__namespace__ = node.namespaceURI;
                    }
                }

                // Examine the properties of the object.
                // - reset the local namespace map
                // - for other properties replace {} with null (to match node soap)
                for (let key in obj) {
                    if (key === 'xmlns') {
                        xmlnsLocal = null;
                    } else if (_.isEmpty(obj[key])) {
                        obj[key] = null;
                    }
                }
            }
        }
        return node;
    }

    // Do the traversal
    d.traverseDOM(dom, pre, null, post);

    // Post process the model to set the namespaces and serviceJSON objects
    if (model.json.definitions) {
        // dom is a wsdl
        model.namespaces = xmlnsGlobal;
        if (model.json.definitions.service) {
            model.serviceJSON = { service: u.deepClone(model.json.definitions.service) };
        }
        if (model.json.definitions.types) {
            if (!model.json.definitions.types.schema) {
                model.json.definitions.types = null;
            }
        }
    } else if (model.json.schema) {
        // dom is a schema
        model.json.schema.xmlns = xmlnsGlobal;
    } else {
        // Neither wsdl or schema. (Error case)
    }
    return model;
}

/**
* @returns true if WSDL namespace or w3 defined namespace or no namespace
*/
function specialNamespace(ns) {
    return ns === '' || (ns && ns.startsWith('http://www.w3.org/') && ns !== NAMESPACE_URI) || ns === WSDL_NS;
}

/**
* @return the text of a node
*/
function getText(node) {
    let text = '';
    let nodes = node.childNodes;
    for (let i = 0; i < nodes.length; i++) {
        let child = nodes[i];
        if (child.nodeName === '#text' || child.nodeName === '#cdata-section') {
            let data = child.data.trim();
            if (data) {
                text += data;
            }
        }
    }
    return text;
}

exports.dom2Model = dom2Model;
