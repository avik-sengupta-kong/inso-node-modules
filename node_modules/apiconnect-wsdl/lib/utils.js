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
const jsyaml = require('js-yaml');
var _ = require('lodash');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');
const q = require('q');

/**
* Utility functions for the apiconnect-wsdl parser
**/

/**
* Return an array representation of the object
*/
function makeSureItsAnArray(obj, addNilObjects) {
    var ret = obj;
    if (!Array.isArray(obj)) {
        ret = [];
        if (obj || addNilObjects) {
            ret.push(obj);
        }
    }
    return ret;
}

/**
* Strip the prefix and return just the xsd name (aka xsd nsName)
*/
function stripNamespace(name) {
    var localName = name;
    if (name) {
        var index = name.indexOf(':');
        if (index != -1) {
            localName = name.substr(index + 1);
        }
    }
    return localName;
}

/**
* @return slugified name
*/
function slugifyName(title) {
    var name = title;
    if (name) {
    // multiple spaces replaced by single hyphen
        name = name.replace(/ +/gi, '-');
        // multiple hyphens replaced by single hyphen
        name = name.replace(/-+/gi, '-');
        // anything not a-z 0-9 A-Z hyphen removed
        name = name.replace(/[^A-Za-z0-9\\-]/gi, '');
        // remove all start hyphens
        name = name.replace(/^[-]+/, '');
        // remove all end hyphens
        name = name.replace(/[-]+$/, '');
        // remove all start numbers
        name = name.replace(/^[0-9]+/, '');
        // only lower case
        name = name.toLowerCase();
    }
    return name;
}

/**
* @return random apha name of the indicate maxLength
*/
function randomAlphaString(length) {
    var chars = 'abcdefghijklmnopqrstuvwxyz';
    var charLen = chars.length;
    var ret = '';
    for (var i = 0; i < length; i++) {
        ret += chars[Math.floor(Math.random() * charLen)];
    } // end for
    return ret;
}

/**
* @return a deep clone of obj
*/
function deepClone(obj) {
    if (obj === null) {
        return null;
    }
    if (typeof obj !== 'object') {
        return obj;
    }
    var child, cloned;
    if (obj instanceof Array) {
        child = [];
        var len = obj.length;
        for (var i = 0; i < len; i++) {
            cloned = deepClone(obj[i]);
            child.push(cloned);
        } // end for
    } else {
        child = {};
        for (var key in obj) {
            cloned = deepClone(obj[key]);
            child[key] = cloned;
        } // end for
    }
    return child;
}

/**
* @param obj
* @param ignore keys to ignore
* @return a deep clone of obj
*/
function deepCloneWithIgnoreKeys(obj, ignore) {
    if (obj === null) {
        return null;
    }
    if (typeof obj !== 'object') {
        return obj;
    }
    var child, cloned;
    if (obj instanceof Array) {
        child = [];
        var len = obj.length;
        for (var i = 0; i < len; i++) {
            cloned = deepCloneWithIgnoreKeys(obj[i], ignore);
            child.push(cloned);
        } // end for
    } else {
        child = {};
        for (var key in obj) {
            if (ignore.indexOf(key) < 0) {
                cloned = deepCloneWithIgnoreKeys(obj[key], ignore);
                child[key] = cloned;
            }
        } // end for
    }
    return child;
}

/**
* Add objects within source to target
*/
function extendObject(target, source, deep) {
    for (var name in source) {
        if (deep) {
            target[name] = deepClone(source[name]);
        } else {
            target[name] = source[name];
        }
    } // end for
    return target;
}

function getObjectName(o) {
    return o && o.constructor && o.constructor.name;
}

/**
* Get a prefix for the indicated namespace, create a new prefix if not found
*/
function getPrefixForNamespace(ns, namespaces, noAutogen) {
    var ret = '';
    var match = [];
    if (!ns) {
        return '';
    }
    if (namespaces != null && typeof namespaces === 'object') {
        for (var prefix in namespaces) {
            var namespace = namespaces[prefix];
            if (ns == namespace) {
                match.push(prefix);
            }
        } // end for
        ret = match.length > 0 ? match[0] : ret;
        if (ret.startsWith('_') && match.length > 1) {
            ret = match[1];
        }
        /*
        if (!ret && ns && !noAutogen && rawPrefix) {
            // If no match found, try adding the rawPrefix to the namespace list
            if (!namespaces[rawPrefix]) {
                namespaces[rawPrefix] = ns;
                ret = rawPrefix;
            }
        }
        */
        if (!ret && !noAutogen) {
            // didn't find a match - need to add a new auto generated one
            var index = 1;
            var newPrefix = 'ns' + index;
            while (namespaces[newPrefix]) {
                index += 1;
                newPrefix = 'ns' + index;
            } // end while
            namespaces[newPrefix] = ns;
            ret = newPrefix;
        }
    }
    return ret;
}

/**
* Return a string representation of the value.
*/
function parseToPrimitive(value) {
    // Remove leading +
    if (value.startsWith('+')) {
        value = value.substring(1);
    }
    // Remove leading 0's
    value = value.replace(/^0+(?=\d)/, '');
    try {
        return JSON.parse(value);
    } catch (e) {
        return value.toString();
    }
}

// list the keys not shared by two objects or those amended since last processed
function disjointKeysToArray(obj, oldObj) {
    var ret = [];
    for (var key in obj) {
        if (!oldObj[key]) {
            ret.push({
                name: key,
                value: deepClone(obj[key])
            });
        } else {
            var previous = oldObj[key];
            if (previous && previous.offset != previous.referencingContexts.length) {
                ret.push({
                    name: key,
                    value: deepClone(obj[key])
                });
            }
        }
    } // end for
    return ret;
}


/**
* @param documentation is a node.soap documentation object
* The documentation element may have 'undefined' or '$value' keys.
* These are removed or changed so that the documentation object is
* either a string or an array of strings.
* @return a string representing the entire text of the documentation.
* The returned string is often used to set a description field in the
* swagger document.
*/
function cleanupDocumentation(documentation, req) {
    var ret = documentation;
    if (documentation) {
        if (typeof documentation !== 'string') {
            // Convert to array and remove attributes from the documentation element
            documentation = makeSureItsAnArray(documentation);
            for (var i = 0; i < documentation.length; i++) {
                if (documentation[i]) {
                    if (documentation[i]['undefined']) {
                        delete documentation[i]['undefined'];
                    }
                    if (documentation[i]['$value']) {
                        documentation[i] = documentation[i]['$value'];
                    }
                }
            }
            let doc = [];
            // Remove whitespace
            for (i = 0; i < documentation.length; i++) {
                if (!documentation[i]) {
                    // don't save null documentation
                } else if (typeof documentation[i] === 'string') {
                    let value = _.trim(documentation[i]);
                    if (value.length > 0) {
                        doc.push(documentation[i]);
                    }
                } else if (typeof documentation[i] === 'object') {
                    if (Object.keys(documentation[i]).length > 0) {
                        doc.push(documentation[i]);
                    }
                } else {
                    doc.push(documentation[i]);
                }
            }
            // Return the single document or a string representation of all the documents
            if (doc.length === 0) {
                ret = '';
            } else if (doc.length == 1 && doc[0] && typeof doc[0] === 'string') {
                ret = doc[0];
            } else {
                ret = JSON.stringify(doc);
            }
        }
    }
    ret = removeNonUTF8Chars(ret);
    if (ret && ret.length > 20000) {
        ret = ret.substring(0, 20000) + g.http(r(req)).f('(Documentation limit exceeded. The text is pruned.)');
    }
    return ret;
}

/**
* return the apiconnect-wsdl getVersion
*/
function getVersion() {
    return require('./../package.json').version;
}

// Don't trigger asserts in production code.
var useAsserts = false;
function setAsserts(val) {
    useAsserts = val;
}

/**
* Create a validation compliant error
*/
function makeValidationErr(message) {
    let valError = new Error(message);
    return convertToValidationErr(valError);
}
/**
* Add text message to the error using the validator format
* { messages: [ {message: <message>}]}
* @param valError the validator style error
* @param stringOrErr the new error to add to valError
*/
function addValidationErr(valError, stringOrErr, req) {
    // Add the messages array
    if (!valError.messages) {
        valError.messages = [];
    }
    // Get the new message
    let message = 'no message';
    try {
        if (typeof stringOrErr === 'string') {
            message = stringOrErr;
        } else {
            if (stringOrErr.message) {
                message = stringOrErr.message;
            } else {
                message = JSON.stringify(stringOrErr);
            }
        }
        let subText = g.http(_(req)).f('An error occurred while parsing "%s".\n', 'MEMORY');
        message = message.replace(subText, '');
    } catch (e) {
        message = 'no message';
    }
    // Add the new message to the messages array
    valError.messages.push({
        message: message
    });
    // Update the error message to be the combined text of all messages.
    valError.message = '';
    let nl = '';
    for (let i = 0; i < valError.messages.length; i++) {
        valError.message += nl + valError.messages[i].message;
        nl = '\n';
    }
    return valError;
}

/**
* Convert the error to the validation error format
*/
function convertToValidationErr(err) {
    if (!err.messages || !(err.messages instanceof Array)) {
        err.messages = [ { message: err.message } ];
    }
    return err;
}

/**
* Load and store from yaml as a quick validation and fixup for any encoding or other common issues.
**/
function checkAndFix(object) {
    try {
        // Use safedump to validate the object
        jsyaml.safeDump(object);
        return object;
    } catch (e) {
        return jsyaml.load(jsyaml.safeDump(object,
           { skipInvalid: true } // Suppress dumping of keys with undefined values without error
        ));
    }
}


/**
* Detect and remove non-UTF8 characters
*/
function removeNonUTF8Chars(text) {
    // Put the text in a json object
    let s = {
        data: text
    };
    // Convert to yaml.  Any non utf chars are converted to hex escapes
    let yaml = jsyaml.dump(s);

    // Now remove the hex escapes
    yaml = yaml.replace(/\\x[0-9A-E][0-9A-E]/g, '');
    return jsyaml.load(yaml).data;
}

/**
* Find all of the $refs deeply nested in obj and return
* a map of refs -> count infomation.
* @param obj
* @return map object: ref string -> { count: number, allOfCount: number}
*/
function findRefs(obj) {
    let map = { refs: {} };
    traverse(obj, function(curr, path, stack) {
        let key = path.length > 0 ? path[path.length - 1] : undefined;
        let key2 = path.length > 1 ? path[path.length - 2] : undefined;
        let key3 = path.length > 2 ? path[path.length - 3] : undefined;

        let isAllOf = path.length > 2 ? path[path.length - 3] === 'allOf' : false;
        let isAncRef = path.length > 1 ? path[path.length - 2] === 'x-anc-ref' : false;
        if (curr && (key === '$ref' || key3 === 'discriminator' && key2 === 'mapping')) {
            let ref = curr;
            map.refs[ref] = map.refs[ref] || { count: 0, allOfCount: 0 };
            map.refs[ref].count += 1;
            if (isAllOf || isAncRef) {
                map.refs[ref].allOfCount += 1;
            }
        }
        return curr;
    });
    return map;
}

/**
* Traverse the object
* @param obj source object
* @param post function called during postFix pass (most common)
* @param pre (optional) function called during the prefix pass.
* @param stack for recursion
*/
function traverse(obj, post, pre, path, stack) {
    path = path || [];
    stack = stack || [];

    if (pre) {
        obj = pre(obj, path, stack);
    }
    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            path.push(i);
            stack.push(obj);
            obj[i] = traverse(obj[i], post, pre, path, stack);
            stack.pop();
            path.pop();
        }
    } else if (obj && typeof obj === 'object') {
        for (var key in obj) {
            if (obj.hasOwnProperty(key)) {
                path.push(key);
                stack.push(obj);
                obj[key] = traverse(obj[key], post, pre, path, stack);
                stack.pop();
                path.pop();
            }
        }
    }
    if (post) {
        obj = post(obj, path, stack);
    }
    return obj;
}

/**
* @param obj
* @param ignoreXML - ignore xml keys
* @return total number of keys and nested keys (including array indices)
*/
function countKeys(obj, ignoreXML) {
    let localObj = ignoreXML ? deepCloneWithIgnoreKeys(obj, [ 'xml' ]) : obj;
    let count = 0;
    traverse(localObj, function(curr) {
        count++;
        return curr;
    });
    return count;
}

/**
* @param obj
* @param keyName remove all occurrences of this key
*/
function removeKey(obj, keyName) {
    traverse(obj, function(curr) {
        if (curr && typeof curr === 'object') {
            delete curr[keyName];
        }
        return curr;
    });
}

/**
* @param obj
* @param keyName remove all occurrences of this key
*/
function shareObjects(obj) {
    let map = {};
    traverse(obj, function(curr) {
        if (curr && typeof curr === 'object') {
            // xml objects are frequently repeated
            // so share these objects
            if (curr.xml) {
                let cacheKey = JSON.stringify(curr.xml);
                if (map[cacheKey]) {
                    curr.xml = map[cacheKey];
                } else {
                    map[cacheKey] = curr.xml;
                }
            }
        }
        return curr;
    });
}

/**
* Traverse the so (schema objects) and xso (xml schema objects).
* Same as traverse, but the postfixFunction and prefixFunction are only called for each so or xso
* @param obj source object
* @param postfixFunction function called during postFix pass (most common)
* @param prefixFunction (optional) function called during the prefix pass.
*/
function traverseSchemaObjects(swagger, postfixFunction, prefixFunction) {
    var nsName;
    var context = { isRoot: false, inXSO: false, inXSOorSO: false };
    return traverse(swagger, function(curr, path, stack) {
        // Postfix call...traversing back up the tree.
        // The postfunction is called if the current object is a schema object
        // The context object is reset
        if (curr) {
            let key = path.length > 0 ? path[path.length - 1] : undefined;
            let key2 = path.length > 1 ? path[path.length - 2] : undefined;
            let key3 = path.length > 2 ? path[path.length - 3] : undefined;
            context.isRoot = key === nsName && (key2 === 'definitions' || key3 === 'components' && key2 === 'schemas');
            if (postfixFunction && context.inXSOorSO) {
                if (isSchemaObject(path, context.isRoot, curr)) {
                    curr = postfixFunction(curr, nsName, context, path, stack);
                }
            }
            if (context.isRoot) {
                // Leaving xso or so
                context.isRoot = false;
                context.inXSO = false;
                context.inXSOorSO = false;
                nsName = null;
            }
        }
        return curr;
    }, function(curr, path, stack) {
        // Prefix call...traversing down the tree.
        // Set the context flags if to indicate whether this is a schema object or xml schema object
        // If this is a schema object, call the prefixFunction
        if (curr) {
            let key = path.length > 0 ? path[path.length - 1] : undefined;
            let key2 = path.length > 1 ? path[path.length - 2] : undefined;
            let key3 = path.length > 2 ? path[path.length - 3] : undefined;

            context.isRoot = (key2 === 'definitions' || key3 === 'components' && key2 === 'schemas');
            if (context.isRoot) {
                if (isSchemaObject(path, context.isRoot, curr)) {
                    // Entering an xso or so, set the context flags
                    nsName = key;
                    context.inXSOorSO = true;
                    // If this is a root object, then we are procesing either a schema object (so)
                    // or an xml schema object (xso).  If the type is wsdl-to-rest or rest, then it is a schema object
                    // else it is an xml schema object
                    let index = (key2 === 'definitions') ? stack.length - 2 : stack.length - 3;
                    context.inXSO = !(stack[index]['x-ibm-configuration'] &&
                        (stack[index]['x-ibm-configuration'].type === 'wsdl-to-rest' ||
                         stack[index]['x-ibm-configuration'].type === 'rest'));
                }  else {
                    context.isRoot = false; // False root
                }
            }
            if (prefixFunction && context.inXSOorSO) {
                if (isSchemaObject(path, context.isRoot, curr)) {
                    curr = prefixFunction(curr, nsName, context, path, stack);
                }
            }
        }
        return curr;
    });
}

/**
* @return true if so (schema object) is truly a schema object
*/
function isSchemaObject(path, isRoot, so) {
    if (!so) {
        return false;
    }
    // Check for properties that should be in a schema object
    if (so.type || so.xml || so.properties || so.$ref ||
        so.allOf || so.oneOf || so.anyOf || so['x-anyType']) {
        // Make sure path ancestors indicate that this is a schema object
        let key = path.length > 0 ? path[path.length - 1] : undefined;
        let key2 = path.length > 1 ? path[path.length - 2] : undefined;
        return isRoot ||
             [ 'properties', 'allOf', 'oneOf', 'anyOf' ].includes(key2) ||
             key === 'items';
    }
    return false;
}

/**
* Traverse the swagger objects.
* Same as traverse, but the postfixFunction is called for each swagger or embedded swagger
* @param obj source object
* @param postfixFunction function called during postFix pass (most common)
*/
function traverseSwagger(swagger, postfixFunction) {
    return traverse(swagger, function(curr, path, stack) {
        // Postfix call
        let key = path.length > 0 ? path[path.length - 1] : undefined;
        let key2 = path.length > 1 ? path[path.length - 2] : undefined;
        if (key === undefined || key2 === 'targets') {
            if (postfixFunction && (curr.swagger || curr.openapi)) {
                return postfixFunction(curr, path, stack);
            }
        }
        return curr;
    });
}

/**
* Due to bugs in the mapping runtime, force allOfs to not exceed 2
*/
function shortenAllOfs(swagger) {
    let list = [];
    traverseSchemaObjects(swagger, function(xso, nsName) {
        if (xso.allOf && xso.allOf.length > 2) {
            let slice = _.slice(xso.allOf, 1);
            xso.allOf = [ xso.allOf[0],
                {
                    allOf: slice,
                } ];
        }
        return xso;
    });
    return list;
}

/**
* Squash redundant allOfs in an xso (xml schema object)
*/
function squashAllOf(xso) {
    if (xso.allOf) {
        flattenAllOf(xso);

        for (let i = 0; i < xso.allOf.length; i++) {
            xso.allOf[i] = squashAllOf(xso.allOf[i]);
        }

        // Try to merge consecutive allOf items
        let allOf = [];
        for (let i = 0; i < xso.allOf.length; i++) {
            allOf.push(xso.allOf[i]);
            if (allOf.length >= 2) {
                let b = allOf.pop();
                let a = allOf.pop();
                if (a.$ref) {
                    allOf.push(a);
                    allOf.push(b);
                } else {
                    let m = mergeXSO(a, [ b ]);
                    if (m) {
                        allOf.push(m);
                    } else {
                        allOf.push(a);
                        allOf.push(b);
                    }
                }
            }
        }
        if (allOf[0].$ref) {
            // Make sure there is one and only two allOf items when there is a ref
            if (allOf.length === 1) {
                allOf.push({
                    type: 'object',
                    properties: {}
                });
            } else if (allOf.length >= 3) {
                allOf = [
                    allOf[0],
                    {
                        xml: {
                            namespace: '',
                            prefix: ''
                        },
                        allOf: allOf.slice(1)
                    } ];
            }
        }
        xso.allOf = allOf;
        // If only one allOf remains, then remove the allOf
        // Don't do this if the allOf is a ref, because that indicates hierarchy.
        // Don't do this if the allOf is an array, because that indicates occurrence of a unnamed construct (i.e. sequence with maxOccurs)
        if (xso.allOf.length == 1 && !xso.allOf[0].$ref  && !xso.allOf[0].items) {
            let target = deepClone(xso);
            let source = deepClone(xso.allOf[0]);
            delete target.allOf;
            delete source.xml;
            xso = _.merge(target, source);
        }
    }
    return xso;
}

/**
* If an allOf contains allOfs, then flatten into a single allOf list
*/
function flattenAllOf(xso) {
    if (xso.allOf) {
        let list = [];
        for (let i = 0; i < xso.allOf.length; i++) {
            let xso2 = xso.allOf[i];
            if (xso2.allOf) {
                list.push(xso2.allOf);
            } else {
                list.push(xso2);
            }
        }
        xso.allOf = _.flatten(list);
    }
}

/**
* merge xso into xso
* @param target target xso
* @param sources source xsos
* @param new xso or null if not able to merge
*/
function mergeXSO(target, sources) {

    // Check empty case
    if (sources.length === 1) {
        if (isEmptyXSO(target)) {
            return sources[0];
        } else if (isEmptyXSO(sources[0])) {
            return target;
        }
    }

    // Create the new xso
    let xso = deepClone(target);
    if (target.allOf || target.oneOf || target.anyOf || target.$ref || target.type === 'array') {
        return null;
    }
    let propertiesCount = target.properties ? Object.keys(target.properties).length : 0;
    let simpleType = target.type === 'object' ? undefined : target.type;
    for (let i = 0; i < sources.length; i++) {
        let source = deepClone(sources[i]);
        if (source.allOf || source.oneOf || source.anyOf || source.$ref || source.type === 'array') {
            return null;
        }
        simpleType = source.type === 'object' ? simpleType : source.type;

        // Add xml if missing on a property
        if (source.properties) {
            for (let propName in source.properties) {
                let prop = source.properties[propName];
                if (prop.type === 'array') {
                    prop = prop.items;
                }
                if (!prop.xml && !prop.$ref) {
                    prop.xml = deepClone(source.xml);
                }
            }
        }
        delete source.xml;
        // Don't lose any required information
        if (source.required && xso.required) {
            source.required = _.union(xso.required, source.required);
        }
        propertiesCount += source.properties ? Object.keys(source.properties).length : 0;
        xso = _.merge(xso, source);
    }
    xso.type = simpleType || xso.type;  // Use simple type if found

    if (propertiesCount === 0) {
        if (xso.type !== 'object') {
            delete xso.properties;
        }
    }
    // Don't do the merge if a property collision occurred
    let xsoPropertiesCount = xso.properties ? Object.keys(xso.properties).length : 0;
    if (propertiesCount === xsoPropertiesCount) {
        return xso;
    } else {
        return null;
    }
}

function isEmptyXSO(xso) {
    let numKeys = Object.keys(xso).length;
    if (xso.properties && Object.keys(xso.properties).length === 0) {
        numKeys--;
    }
    if (xso.type === 'object') {
        numKeys--;
    }
    if (xso.xml) {
        numKeys--;
    }
    return numKeys === 0;
}

/**
* Return true if the nsName is in a polymorphic hierarchy which is referenced.
* @param definitions
* @param nsName: name of definition in definitions object
* @param anc: ancestor array (output of getAncestorRefs)
* @paran map: Reference map array (output of findRefs)
* @return true or false
*/
function inPolyHierarchy(definitions, nsName, anc, map) {
    let def = definitions[nsName];
    if (anc) {
        // In a poly hierachy if any of the ancestors is referenced in a non-allOf context.
        for (let i = 0; i < anc.length; i++) {
            let mapRef = map.refs[anc[i]];
            if (mapRef && (mapRef.count - mapRef.allOfCount > 0)) {
                return true;
            }
        }
    }
    // Root of poly hierachy if no ancestors and referenced and x-ibm-discriminator
    if (def && def['x-ibm-discriminator']) {
        let ref = '#/definitions/' + nsName;
        let mapRef = map.refs[ref];
        if (mapRef && (mapRef.count - mapRef.allOfCount > 0)) {
            return true;
        }
    }
    return false;
}

/**
* Return map of subTypes
* @param definitions
* @param subTypes: initially not set, map of subTypes
* @return subTypes map (key:base, value array of subTypes)
*/
function getSubTypes(definitions, subTypes) {
    subTypes = subTypes || {};
    for (let nsName in definitions) {
        let def = definitions[nsName];
        if (def.allOf && def.allOf.length > 0 && def.allOf[0].$ref) {
            let base = getDefNameFromRef(def.allOf[0].$ref);
            if (definitions[base] && definitions[base]['x-ibm-discriminator']) {
                if (!subTypes[base]) {
                    subTypes[base] = [];
                }
                subTypes[base].push(nsName);
            }
        }
    }
    return subTypes;
}

/**
* Return map of subTypes
* @param definitions
* @param subTypes: initially not set, map of subTypes
* @return subTypes map (key:base, value array of subTypes)
*/
function getSubTypesV3(definitions, subTypes) {
    subTypes = subTypes || {};
    for (let nsName in definitions) {
        let def = definitions[nsName];
        if (def.discriminator) {
            if (def.oneOf && def.oneOf.length > 1) {
                subTypes[nsName] = [];
                for (let i = 1; i < def.oneOf.length; i++) {
                    let nsName2 = getDefNameFromRef(def.oneOf[i].$ref);
                    subTypes[nsName].push(nsName2);
                }
            }
        }
    }
    return subTypes;
}

function getDescendents(nsName, subTypes) {
    if (!subTypes[nsName]) {
        return [];
    }
    let descendents = deepClone(subTypes[nsName]);
    for (let i = 0; i < subTypes[nsName].length; i++) {
        descendents = _.union(descendents, getDescendents(subTypes[nsName][i], subTypes));
    }
    return descendents;
}

/**
* Return array or ancestor references
* @param definitions
* @param nsName: name of definition in definitions object
* @return array of reference strings
*/
function getAncestorRefs(definitions, nsName, req, anc) {
    let def = definitions[nsName];
    // The first ref in an allOf is always a reference to the ancestor definition
    if (def && def.allOf && def.allOf.length > 0 && def.allOf[0]['$ref']) {
        let ref = def.allOf[0]['$ref'];
        anc = anc || [];
        if (anc.includes(ref)) {
            throw g.http(r(req)).Error('Reference cycle detected in extension or restriction hierarchy: %s', anc);
        }
        // Its an ancestor if it has a discriminator
        // If it does not have a discriminator it is simply content (i.e. perhaps a group reference)
        let ancNSName = getDefNameFromRef(ref);
        let ancDef = definitions[ancNSName];
        if (ancDef && ancDef['x-ibm-discriminator']) {
            anc = anc.concat([ ref ]);
            anc = getAncestorRefs(definitions, getDefNameFromRef(ref), req, anc);
        }
    }
    return anc;
}

/**
* Convience method
*/
function getDefNameFromRef(ref) {
    return ref.substring(ref.lastIndexOf('/') + 1);
}

/**
* String replacement on each ref
*/
function replaceRefs(obj, list) {
    let map = { refs: {} };
    traverse(obj, function(curr, path, stack) {
        let key = path.length > 0 ? path[path.length - 1] : undefined;
        let key2 = path.length > 1 ? path[path.length - 2] : undefined;
        let key3 = path.length > 2 ? path[path.length - 3] : undefined;
        if (curr && (key === '$ref' || key3 === 'discriminator' && key2 === 'mapping')) {
            let ref = curr;
            for (let i = 0; i < list.length; i++) {
                if (ref.indexOf(list[i].source >= 0)) {
                    curr = ref.replace(list[i].source, list[i].target);
                    return curr;
                }
            }
        }
        return curr;
    });
    return map;
}

function wseRelatedNamespace(ns) {
    return ns === 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd' ||
           ns === 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
}

function wsAddrRelatedNamespace(ns) {
    return ns === 'http://www.w3.org/2005/08/addressing' ||
           ns === 'http://www.w3.org/2006/02/addressing/wsdl';
}

/**
* Remove all of the description objects from the xml schema objects
*/
function removeDescription(swagger) {
    return traverseSchemaObjects(swagger, function(s) {
        if (s) {
            delete s.description;
        }
        return s;
    });
}

/*
* Default request to Operating system or english if a
* reqest object is not provided.
*/
function r(req) {
    if (!req && !require('../src/wsdl.js').DEFAULT_GLOBALIZE_USE_OS) {
        req = {
            headers: {
                'accept-language': 'en',
            },
        };
    }
    return req;
}

/**
* @return the file name from a path
*/
function fileNameFromPath(path) {
    return path.replace(/^.*[\\\/]/, '');
}


/**
* @return true if NMTOKEN
**/
function isNMTOKEN(name) {
    // Approximation of NMTOKEN

    let regexp = /^[^\b\t\n\f$ \r'\\\",!#$%&()+;<=>?@{}|]*$/;
    return regexp.test(name);
}

/**
* @return true if NCName
**/
function isNCName(name) {
    // Approximation of NCName (non-colon name)
    // The first character must be a letter or underscore, remaining characters must be letter, digit, underscore or period.
    // Note that non-latin letters are permitted.
    // let regexp = /[^1-9\.:\b\t\n\f$ \r'\\\",!#$%&()+;<=>?@{}|]+[^:\b\t\n\f$ \r'\\\",!#$%&()+;<=>?@{}|]*/;
    // let regexp = /[^:\b\t\n\f$ \r'\\\",!#$%&()+;<=>?@{}|]+/;

    let regexp = /^[^1-9\.:\b\t\n\f$ \r'\\\",!#$%&()+;<=>?@{}|]+[^:\b\t\n\f$ \r'\\\",!#$%&()+;<=>?@{}|]*$/;
    return regexp.test(name);
}

/**
* @return true if QName
*/
function isQName(name) {
    let names = name.split(':');
    if (names.length === 1) {
        // non-prefixed qname
        return isNCName(names[0]);
    } else if (names.length === 2) {
        // prefixed qname
        return isNCName(names[0]) && isNCName(names[1]);
    } else {
        return false;
    }
}

/**
* Analyzes the swagger to determine if the policies match the gateway setting.
* An error is thrown if a problem is found
* @param swagger
*/
function checkGateway(swagger, req) {
    const allowed = [ 'datapower-gateway', 'datapower-api-gateway', 'micro-gateway' ];
    let gateway = swagger['x-ibm-configuration'].gateway;

    if (allowed.indexOf(gateway) < 0) {
        throw g.http(r(req)).Error('The gateway %s is incorrect.  Expected %s.', gateway, allowed);
    }
    if (gateway === 'datapower-api-gateway') {
        checkV6Policies(swagger, req);
    } else {
        checkV5Policies(swagger, req);
    }
    // Repeat for targets
    if (swagger['x-ibm-configuration'].targets) {
        for (let service in swagger['x-ibm-configuration'].targets) {
            let inner = swagger['x-ibm-configuration'].targets[service];
            checkGateway(inner, req);
        }
    }
    return;
}

/**
* Analyzes the swagger to make sure V5 policies are used.
* An error is thrown if a problem is found
* @param swagger
*/
function checkV5Policies(swagger, req) {

    let assembly = swagger['x-ibm-configuration'].assembly;
    let gateway = swagger['x-ibm-configuration'].gateway;

    traverse(assembly, function(obj, path) {
        let name = path.length > 0 && path[path.length - 1];
        if (name === 'execute') {
            let execute = obj;
            for (let i = 0; i < execute.length; i++) {
                if (execute[i].invoke) {
                    if (execute[i].invoke.version && execute[i].invoke.version !== '1.0.0') {
                        throw g.http(r(req)).Error('The invoke version %s conflicts with the gateway %s.', execute[i].invoke.version, gateway);
                    }
                } else if (execute[i].map) {
                    if (execute[i].map.version && execute[i].map.version !== '1.0.0') {
                        throw g.http(r(req)).Error('The map version %s conflicts with the gateway %s.', execute[i].map.version, gateway);
                    }
                } else if (execute[i].switch) {
                    throw g.http(r(req)).Error('The switch policy conflicts with the gateway %s.  Expected operation-switch.', gateway);
                }
            }
        }
        return obj;
    });

    return;
}

/**
* Analyzes the swagger to make sure V5 policies are used.
* An error is thrown if a problem is found
* @param swagger
*/
function checkV6Policies(swagger, req) {

    let assembly = swagger['x-ibm-configuration'].assembly;
    let gateway = swagger['x-ibm-configuration'].gateway;

    traverse(assembly, function(obj, path) {
        let name = path.length > 0 && path[path.length - 1];
        if (name === 'execute') {
            let execute = obj;
            for (let i = 0; i < execute.length; i++) {
                if (execute[i].invoke) {
                    if (execute[i].invoke.version !== '2.0.0') {
                        throw g.http(r(req)).Error('The invoke version %s conflicts with the gateway %s.', execute[i].invoke.version, gateway);
                    }
                } else if (execute[i].map) {
                    if (execute[i].map.version !== '2.0.0') {
                        throw g.http(r(req)).Error('The map version %s conflicts with the gateway %s.', execute[i].map.version, gateway);
                    }
                } else if (execute[i]['operation-switch']) {
                    throw g.http(r(req)).Error('The operation-switch policy conflicts with the gateway %s.  Expected switch.', gateway);
                } else if (execute[i].proxy) {
                    throw g.http(r(req)).Error('The proxy policy conflicts with the gateway %s.  Expected invoke.', gateway);
                }
            }
        }
        return obj;
    });

    return;
}

/**
* Port this api to a datapower-api-gateway
* @param swagger
* @return swagger updated with V6 Gateway and Policies
*/
function portToV6Gateway(swagger, req) {
    let gateway = swagger['x-ibm-configuration'].gateway;
    if (gateway === 'datapower-api-gateway') {
        return swagger;
    }
    swagger['x-ibm-configuration'].gateway = 'datapower-api-gateway';
    traverse(swagger['x-ibm-configuration'].assembly, function(obj, path) {
        let name = path.length > 0 && path[path.length - 1];
        if (name === 'execute') {
            let execute = obj;
            let newExecute = [];
            for (let i = 0; i < execute.length; i++) {
                if (execute[i].invoke) {
                    let x = {};
                    x.invoke = execute[i].invoke;
                    x.invoke.version = '2.0.0';
                    x.invoke['header-control'] = {
                        type: 'blacklist',
                        values: []
                    };
                    x.invoke['parameter-control'] = {
                        type: 'blacklist',
                        values: []
                    };
                    newExecute.push(x);
                } else if (execute[i].map) {
                    let x = {};
                    x.map = execute[i].map;
                    x.map.version = '2.0.0';

                    // The generated map will contain either
                    // inputs.<key>.variable:request.body -or-
                    // inputs.<key>.variable:message.body
                    //
                    // If the input is 'request'
                    //   parse request to message
                    // If the input is message
                    //   parse message to message (parse in place)
                    let input;
                    for (let key in x.map.inputs) {
                        let v = x.map.inputs[key].variable;
                        if (v === 'request.body') {
                            input = 'request';
                            x.map.inputs[key].variable = 'message.body';
                        } else if (v === 'message.body') {
                            input = 'message';
                        }
                    }
                    if (input) {
                        newExecute.push({
                            parse: {
                                version: '2.0.0',
                                title: 'parse',
                                'parse-settings-reference': {
                                    default: 'apic-default-parsesettings'
                                },
                                input: input,
                                output: 'message'
                            }
                        });
                    }
                    newExecute.push(x);
                } else if (execute[i]['operation-switch']) {
                    let x = {};

                    x.switch = execute[i]['operation-switch'];
                    x.switch.version = '2.0.0';
                    x.switch.title = x.switch.title === 'operation-switch' ? 'switch' : x.switch.title;
                    if (x.switch.case) {
                        for (let i = 0; i < x.switch.case.length; i++) {
                            let operations = x.switch.case[i].operations;
                            x.switch.case[i] = {
                                condition: '',
                                execute: x.switch.case[i].execute
                            };
                            let conditions = [];
                            // Example condition: (($httpVerb() = 'POST' and $operationPath() = '/Add'))
                            if (operations) {
                                for (let j = 0; j < operations.length; j++) {
                                    let op = operations[j];
                                    let terms = [];
                                    if (op.verb) {
                                        terms.push('$httpVerb() = \'' + op.verb.toUpperCase() + '\'');
                                    }
                                    if (op.path) {
                                        terms.push('$operationPath() = \'' + op.path + '\'');
                                    }
                                    conditions.push('(' + _.join(terms, ' and ') + ')');
                                }
                            }
                            x.switch.case[i].condition = '(' + _.join(conditions, '||') + ')';
                        }
                    }
                    newExecute.push(x);
                } else if (execute[i].proxy) {
                    let x = {};
                    x.invoke = execute[i].proxy;
                    x.invoke.title = x.invoke.title === 'proxy' ? 'invoke' : x.invoke.title;
                    x.invoke.version = '2.0.0';
                    x.invoke['header-control'] = {
                        type: 'blacklist',
                        values: []
                    };
                    x.invoke['parameter-control'] = {
                        type: 'blacklist',
                        values: []
                    };
                    newExecute.push(x);
                } else {
                    newExecute.push(execute[i]);
                }
            }
            obj = newExecute;
        }
        return obj;
    });

    // Repeat for targets
    if (swagger['x-ibm-configuration'].targets) {
        for (let service in swagger['x-ibm-configuration'].targets) {
            let inner = swagger['x-ibm-configuration'].targets[service];
            swagger['x-ibm-configuration'].targets[service] = portToV6Gateway(inner, req);
        }
    }
    return swagger;
}

/**
* Add the json validate policies.
* @param swagger
* @req i18n request object
* @return swagger updated with validate policies
*/
function addValidatePolicies(swagger, req) {
    let isAPIGW = swagger['x-ibm-configuration'].gateway == 'datapower-api-gateway';
    traverse(swagger['x-ibm-configuration'].assembly.execute, function(obj, path) {
        let name = path.length > 0 && path[path.length - 1];
        if (name === 'execute') {
            let execute = obj;
            // Add a validate poicy at the front of the execution flow
            // It is placed in front of the map for request
            // (If GET and query params are used, then no input validate policy is needed)
            let i = 0;
            if (execute[i].parse) {
                i++;
            }
            if (execute[i].map && execute[i].map.inputs.request) {
                let validate = isAPIGW ? {
                    validate: {
                        version: '2.0.0',
                        title: 'validate',
                        input: 'message',
                        output: 'message',
                        description: 'validate request',
                        'validate-against': 'definition',
                        definition: execute[i].map.inputs.request.schema.$ref
                    }
                } : {
                    validate: {
                        version: '1.0.0',
                        title: 'validate',
                        description: 'validate request',
                        definition: execute[i].map.inputs.request.schema.$ref
                    }
                };
                execute.splice(i, 0, validate);
            }
            // Add a validate policy at the end of the execution flow, after the map
            i = execute.length - 1;
            if (execute[i].map) {
                let validate = isAPIGW ? {
                    validate: {
                        version: '2.0.0',
                        title: 'validate',
                        input: 'message',
                        output: 'message',
                        description: 'validate response',
                        'validate-against': 'definition',
                        definition: execute[i].map.outputs.response.schema.$ref
                    }
                } : {
                    validate: {
                        version: '1.0.0',
                        title: 'validate',
                        description: 'validate response',
                        definition: execute[i].map.outputs.response.schema.$ref
                    }
                };
                execute.push(validate);
            }
        }
        return obj;
    });

    // Repeat for targets
    if (swagger['x-ibm-configuration'].targets) {
        for (let service in swagger['x-ibm-configuration'].targets) {
            let inner = swagger['x-ibm-configuration'].targets[service];
            swagger['x-ibm-configuration'].targets[service] = portToV6Gateway(inner, req);
        }
    }
    return swagger;
}


/**
* Add Test Paths for each path
* @param swagger
* @param req i18n request objects
*/
function addTestPaths(swagger, req) {
    // Get the paths that can be optimized
    let paths = Object.keys(swagger.paths);
    let service = Object.keys(swagger['x-ibm-configuration'].targets)[0];
    let targetSwagger = swagger['x-ibm-configuration'].targets[service];
    // Process each of the paths
    paths.forEach((path) => {
        // Create a path to echo the input (if there is an input)
        if (swagger.paths[path].post &&
            swagger.paths[path].post.parameters &&
            swagger.paths[path].post.parameters.length === 1 &&
            swagger.paths[path].post.parameters[0].schema &&
            swagger.paths[path].post.parameters[0].schema.$ref) {
            let echoPath = path + '_TEST_InputEcho';
            let restRef = swagger.paths[path].post.parameters[0].schema.$ref;
            let soapRef = targetSwagger.paths[path].post.parameters[0].schema.$ref;
            let operationElement = Object.keys(getRefXSO(swagger, soapRef).properties['Envelope'].properties['Body'].properties)[0];

            // Create and add the path
            swagger.paths[echoPath] = deepClone(swagger.paths[path]);
            swagger.paths[echoPath].post.responses = {
                default: {
                    description: '',
                    schema: {
                        $ref: restRef
                    }
                }
            };

            // Create and add a case flow that echos the input
            //  1) maps the rest input to the soap input
            //  2) maps the soap input back to the rest input (which is the response for the echo)
            let caseStmt = swagger['x-ibm-configuration'].assembly.execute[0]['operation-switch'].case;
            caseStmt.push(createEchoCase(echoPath, restRef, soapRef, operationElement));
        }
        // Create a path to echo the output (if there is an output)
        if (swagger.paths[path].post &&
            swagger.paths[path].post.responses) {
            // Use the normal output (200), if it doesn't exist use the default
            let code = swagger.paths[path].post.responses['200'] ? '200' : 'default';
            let targetCode = targetSwagger.paths[path].post.responses['200'] ? '200' : 'default';

            if (swagger.paths[path].post.responses[code] &&
                swagger.paths[path].post.responses[code].schema &&
                swagger.paths[path].post.responses[code].schema.$ref) {
                let echoPath = path + '_TEST_OutputEcho';
                let restRef = swagger.paths[path].post.responses[code].schema.$ref;
                let soapRef = targetSwagger.paths[path].post.responses[targetCode].schema.$ref;
                let operationElement = Object.keys(getRefXSO(swagger, soapRef).properties['Envelope'].properties['Body'].properties)[0];

                // Create and add the path
                swagger.paths[echoPath] = deepClone(swagger.paths[path]);
                swagger.paths[echoPath].post.parameters = [ {
                    name: 'request',
                    required: true,
                    in: 'body',
                    schema: {
                        $ref: restRef
                    }
                } ];

                // Create and add a case flow that echos the output
                //  1) maps the rest output to the soap output
                //  2) maps the soap output back to the rest output (which is the response for the echo)
                let caseStmt = swagger['x-ibm-configuration'].assembly.execute[0]['operation-switch'].case;
                caseStmt.push(createEchoCase(echoPath, restRef, soapRef, operationElement));
            }
        }
    }); // end iterate paths
}

/**
* Create an assembly case for an operation-switch for a test echo
* @param echoPath name of the path for the echo
* @param restRef input (rest)
* @param soapRef backend (soap)
* @param operationElement the operation element used in the soap ref
* @return case object
*/
function createEchoCase(echoPath, restRef, soapRef, operationElement) {
    return {
        operations: [ {
            verb: 'post',
            path: echoPath,
        } ],
        execute: [ {
            map: {
                inputs: {
                    request: {
                        schema: { $ref: restRef },
                        variable: 'request.body',
                        content: 'application/json'
                    }
                },
                outputs: {
                    body: {
                        schema: { $ref: soapRef },
                        variable: 'message.body',
                        content: 'text/xml'
                    }
                },
                actions: [ {
                    set: 'body.Envelope.Body.' + operationElement,
                    from: 'request'
                } ],
                options: {
                    includeEmptyXMLElements: false,
                    inlineNamespaces: false,
                    mapEnablePostProcessingJSON: true,
                    mapResolveXMLInputDataType: true,
                    mapResolveApicVariables: false
                }
            }
        }, {
            map: {
                inputs: {
                    input: {
                        schema: { $ref: soapRef },
                        variable: 'message.body',
                        content: 'application/xml'
                    }
                },
                outputs: {
                    response: {
                        schema: { $ref: restRef },
                        variable: 'message.body',
                        content: 'application.json'
                    }
                },
                actions: [ {
                    set: 'response',
                    from: 'input.Envelope.Body.' + operationElement
                } ],
                options: {
                    includeEmptyXMLElements: false,
                    inlineNamespaces: false,
                    mapEnablePostProcessingJSON: true,
                    mapResolveXMLInputDataType: true,
                    mapResolveApicVariables: false
                }
            }
        } ]
    };
}

/**
* Add GET methods and assembly actions to the 2.0 swagger for each
* POST method that has 5 or fewer simple parameters.
* @param swagger
* @param req i18n request objects
*/
function addGetMethods(swagger, req) {
    // Get the paths that can be optimized
    let paths = getPathsForGetOptimization(swagger);
    // Process each of the paths
    paths.forEach((path) => {
        // Add a get object to the path
        swagger.paths[path].get = deepClone(swagger.paths[path].post);
        if (swagger.paths[path].get.operationId) {
            swagger.paths[path].get.operationId += 'GET';
        }
        delete swagger.paths[path].get.parameters;
        let xso = getRefXSO(swagger, swagger.paths[path].post.parameters[0].schema.$ref);

        // Each of the parameters of the GET method is a query parameter
        if (Object.keys(xso.properties).length > 0) {
            swagger.paths[path].get.parameters = [];
            for (let key in xso.properties) {
                let prop = deepClone(xso.properties[key]);
                let param = {
                    name: key,
                    in: 'query',
                    type: prop.type
                };
                if (xso.required && _.indexOf(xso.required, key) >= 0) {
                    param.required = true;
                }
                _.assign(param, _.pick(prop, [ 'description', 'format', 'default', 'enum', 'multipleOf',
                    'maximum', 'minimum', 'exclusiveMaximum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern' ]));
                swagger.paths[path].get.parameters.push(param);
            }
        }

        // Add assembly for GET
        let cases;
        if (swagger['x-ibm-configuration'] &&
            swagger['x-ibm-configuration'].assembly &&
            swagger['x-ibm-configuration'].assembly.execute &&
            swagger['x-ibm-configuration'].assembly.execute[0] &&
            swagger['x-ibm-configuration'].assembly.execute[0]['operation-switch']) {
            cases = swagger['x-ibm-configuration'].assembly.execute[0]['operation-switch'].case;
        }
        if (cases) {
            // Locate the POST case.
            let postCase;
            for (let i = 0; i < cases.length; i++) {
                if (cases[i].operations &&
                    cases[i].operations.length === 1 &&
                    cases[i].operations[0].verb === 'post' &&
                    cases[i].operations[0].path === path) {
                    postCase = cases[i];
                    break;
                }
            }

            // Create a GET case
            if (postCase) {
                let getCase = deepClone(postCase);
                let map = getCase.execute[0].map;
                if (map) {
                    getCase.operations[0].verb = 'get';

                    // The POST actions are a combination of
                    //   actions to set the SOAP related HTTP headers
                    //   a singele action to set the operation element within the request.body
                    // The GET actions are a combination of
                    //   actions to set the SOAP related HTTP headers
                    //   actions to set individual parameter elements within the request.body using query parameters
                    map.actions = [];
                    let postActions = postCase.execute[0].map.actions;
                    let base;
                    for (let i = 0; i < postActions.length; i++) {
                        if (postActions[i].from === 'request') {
                            base = postActions[i].set;
                        } else {
                            map.actions.push(deepClone(postActions[i]));
                        }
                    }
                    // The inputs are the query parameters,
                    // And new actions are added to wire the query parameters
                    // to the xml elements.
                    map.inputs = {};
                    for (let key in xso.properties) {
                        let prop = xso.properties[key];
                        map.inputs[key] = {
                            schema: {
                                type: prop.type,  // Use the same OAI type in the map schema
                            },
                            variable: 'request.parameters.' + key
                        };
                        if (prop.format) {
                            map.inputs[key].schema.format = prop.format; // Use the same OAI format in the map schema
                        }
                        map.actions.push({
                            set: base + '.' + key,
                            from: key
                        });
                    }
                    // Add the new GET case to the assembly
                    cases.push(getCase);
                }  // end add new GET case with appropriately wired map
            } // end found matching post case
        } // end if assembly cases
    }); // end iterate paths
}

// formats that are supported/generated by apiconnect-wsdl
const FORMATS = [ 'int32', 'int64', 'float', 'double', 'byte', 'binary', 'date', 'date-time' ];

/**
* @param swagger
* @return array of path names that are suitable for a GET optimization
*/
function getPathsForGetOptimization(swagger) {
    let paths = [];
    for (let path in swagger.paths) {
        // The POST must have only one input parameter
        if (swagger.paths[path].post &&
            swagger.paths[path].post.parameters &&
            swagger.paths[path].post.parameters.length == 1) {
            let parameter = swagger.paths[path].post.parameters[0];
            // and the parameter must be a body parameter defined by a xso (xml schema object)
            if (parameter.in === 'body' && parameter.schema && parameter.schema.$ref) {
                // and the xso must be an object with <= 5 properties
                let xso = getRefXSO(swagger, parameter.schema.$ref);
                if (xso &&
                    xso.type === 'object' &&
                    xso.properties &&
                    Object.keys(xso.properties).length <= 5) {
                    let optimize = true;
                    // and each property must be simple
                    for (let key in xso.properties) {
                        let prop = xso.properties[key];
                        if (!prop.type || prop.type === 'object' || prop.type === 'array' || // If not a scalar type
                            prop.format && FORMATS.indexOf(prop.format) < 0) {               // or if unknown format used
                            optimize = false;
                            break;
                        }
                    }
                    if (optimize) {
                        paths.push(path);
                    }
                }
            }
        }
    }
    return paths;
}

function getRefXSO(swagger, ref) {
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

function makeOld(swagger) {
    if (swagger['x-ibm-configuration'].targets) {
        for (let target in swagger['x-ibm-configuration'].targets) {
            swagger['x-ibm-configuration'].targets[target] =
              _makeOld(swagger['x-ibm-configuration'].targets[target], '#/x-ibm-configuration/targets/' + target + '/definitions/');
        }
    }
    return _makeOld(swagger, '#/definitions/');
}


function _makeOld(swaggerNew, path) {
    let new2old = getOldNCNames(swaggerNew);
    let swaggerOld = deepClone(swaggerNew);
    swaggerOld.definitions = {};
    for (let newNCName in swaggerNew.definitions) {
        let oldNCName = new2old[newNCName];
        swaggerOld.definitions[oldNCName] = deepClone(swaggerNew.definitions[newNCName]);
    }
    replaceRefValues(swaggerOld, new2old, path);
    return swaggerOld;
}



function getOldNCNames(swagger) {
    let old2new = {};
    let new2old = {};
    for (let ncName in swagger.definitions) {
        let words = _.split(ncName, '_');
        if (words.length > 1 && words[1] === 'element') {
            words = _.remove(words, function(value, index) {
                return !(value === 'element'  && index === 1);
            });
            let ncNameOld = _.join(words, '_');
            if (ncNameOld.includes('_for_')) {
                ncNameOld = ncNameOld.replace('_element_', '_');
            }
            old2new[ncNameOld] = ncName;
            new2old[ncName] = ncNameOld;
        } else if (words.length > 1 && words[1] === 'attribute') {
            // Probably shouldn't get here since attributes are inlined
            words = _.remove(words, function(value, index) {
                return !(value === 'attribute'  && index === 1);
            });
            words.splice(2, 0, 'attr');
            let ncNameOld = _.join(words, '_');
            if (ncNameOld.includes('_for_')) {
                ncNameOld = ncNameOld.replace('_element_', '_');
            }
            old2new[ncNameOld] = ncName;
            new2old[ncName] = ncNameOld;
        } else if (words.length > 1 && words[1] === 'type') {
            // Process in second pass
        } else {
            old2new[ncName] = ncName;
            new2old[ncName] = ncName;
        }
    }
    for (let ncName in swagger.definitions) {
        let words = _.split(ncName, '_');
        if (words.length > 1 && words[1] === 'type') {
            words = _.remove(words, function(value, index) {
                return !(value === 'type'  && index === 1);
            });
            let ncNameOld = _.join(words, '_');
            if (old2new[ncNameOld]) {
                let def = swagger.definitions[ncName];
                if (def.xml && def.xml.prefix && def.xml.prefix !== '') {
                    ncNameOld += '_' + def.xml.prefix;
                } else {
                    ncNameOld += '_unqual';
                }
            }
            if (ncNameOld.includes('_for_')) {
                ncNameOld = ncNameOld.replace('_element_', '_');
            }
            old2new[ncNameOld] = ncName;
            new2old[ncName] = ncNameOld;
        }
    }
    return new2old;
}

/**
* String replacement on each ref
*/
function replaceRefValues(obj, map, path) {
    let map2 = {};
    for (let key in map) {
        map2[path + key] = path + map[key];
    }
    traverse(obj, function(curr, path, stack) {
        let key = path.length > 0 ? path[path.length - 1] : undefined;
        let key2 = path.length > 1 ? path[path.length - 2] : undefined;
        let key3 = path.length > 2 ? path[path.length - 3] : undefined;
        if (curr && (key === '$ref' || key3 === 'discriminator' && key2 === 'mapping')) {
            if (map2[curr]) {
                curr = map2[curr];
            }
        } else if (curr && key === 'x-xsi-type-uniquename') {
            if (map[curr]) {
                curr = map[curr];
            } else if (curr.indexOf('_type_') || curr.indexOf('_element_')) {
                curr = curr.replace('_type_', '_');
                curr = curr.replace('_element_', '_');
            }
        }
        return curr;
    });
}

/**
* This function takes a completed swagger (v2 or v3) and creates a detail map.
* The detail map captures information about the swagger that would be relevant for serialization
* or deserialization of the xml.  For example, it captures the namespaces and xsi types for every child element.
* The detail map information should be the same for a V2 or V3 swagger.  The detail map information is used during
* automated fvt to ensure the V2 and V3 generated apis for the same wsdl are logically equivalent.
*/
function detailMap(swagger) {
    let map = {};
    traverseSchemaObjects(swagger, function(xso) {
        if (xso.properties) {
            for (let p in xso.properties) {
                map[p] = map[p] || {
                    namespaces: [],
                    xsiTypes: [],
                    isAttribute: false,
                    isElement: false,
                    children: [],
                    nullable: false,
                    nonNullable: false
                };
                let nullable = isNullable(xso.properties[p], swagger);
                if (nullable) {
                    map[p].nullable = true;
                } else {
                    map[p].nonnullable = true;
                }
                let namespace = getNamespace(xso.properties[p], swagger);
                if (map[p].namespaces.indexOf(namespace) < 0) {
                    map[p].namespaces.push(namespace);
                    map[p].namespaces = map[p].namespaces.sort();
                }
                let xsiType = getXSIType(xso.properties[p], getDefinitions(swagger));
                if (map[p].xsiTypes.indexOf(xsiType) < 0) {
                    map[p].xsiTypes.push(xsiType);
                    map[p].xsiTypes = map[p].xsiTypes.sort();
                }
                let children = getChildren(xso.properties[p], swagger);
                map[p].children = _.union(map[p].children, children).sort();
                let attr = isAttribute(xso.properties[p], swagger);
                if (attr) {
                    map[p].isAttribute = true;
                } else {
                    map[p].isElement = true;
                }
            }
        }
        return xso;
    });
    let keys = Object.keys(map).sort();
    let map2 = {};
    for (let i = 0; i < keys.length; i++) {
        map2[keys[i]] = map[keys[i]];
    }
    return {
        properties: map2,
        polyTypes: getXSITypes(swagger)
    };
}

/**
* Create a map of xsiType (p:name) -> all descendent polymorphic xsi types
*/
function getXSITypes(swagger, req) {
    let subTypes = {};
    let definitions = getDefinitions(swagger);
    let refs = findRefs(definitions);
    subTypes = getSubTypes(definitions, subTypes);
    subTypes = getSubTypesV3(definitions, subTypes);
    let desc = {};
    for (let nsName in definitions) {
        let descTypes = getDescendents(nsName, subTypes);
        if (descTypes && descTypes.length > 0) {
            desc[nsName] = descTypes;
        }
    }
    let map = {};
    for (let nsName in desc) {
        let ref = swagger.definitions ? '#/definitions/' + nsName : '#/components/schemas/' + nsName;
        if (!refs.refs[ref]  || ((refs.refs[ref].count - refs.refs[ref].allOfCount) <= 0)) {
            continue;
        }
        let xso = definitions[nsName];
        if (!xso.discriminator && !xso['x-ibm-discriminator']) {
            continue;
        }
        let xsiType = getXSIType(xso, getDefinitions(swagger));
        let descs = desc[nsName];
        let xsiTypes = [];
        for (let i = 0; i < descs.length; i++) {
            let xso2 = definitions[descs[i]];
            let xsiType2 = getXSIType(xso2, getDefinitions(swagger));
            if (xsiType2 === 'NONE') {
                // Known corner case with V2 element inlining of complexType
                continue;
            }
            if (xsiTypes.indexOf(xsiType2) >= 0) {
                // Known corner case with V2 substitution group implementation
                if (descs[i].indexOf('_of_') < 0) {
                    throw new Error('Duplicate xsiType ' + xsiType2 + ' in hierarchy of ' + xsiType + ' for ' + nsName);
                }
            } else {
                xsiTypes.push(xsiType2);
            }
            xsiTypes.sort();
        }
        if (!map[xsiType]) {
            map[xsiType] = xsiTypes;
        } else if (!_.isEqual(map[xsiType], xsiTypes)) {
            throw new Error('Different hierarchies for xsiType ' + xsiType + ': ' + map[xsiType] + ' and ' + xsiTypes + ' of ' + nsName);
        }
    }
    let keys = Object.keys(map).sort();
    let map2 = {};
    for (let i = 0; i < keys.length; i++) {
        map2[keys[i]] = map[keys[i]];
    }
    return map2;
}

function getDefinitions(swagger) {
    return swagger.definitions || swagger.components.schemas;
}

/**
* @return true if xso is nullable
*/
function isNullable(xso, swagger) {
    if (xso.nullable !== undefined) {
        return xso.nullable;
    } else if (xso['x-nullable'] !== undefined) {
        return xso['x-nullable'];
    } else if (xso['$ref']) {
        let nsName = getDefNameFromRef(xso['$ref']);
        let xso2 = getDefinitions(swagger)[nsName];
        return isNullable(xso2, swagger);
    }
    return false;
}

/**
* @return namespace of xso
*/
function getNamespace(xso, swagger) {
    if (xso['$ref']) {
        let nsName = getDefNameFromRef(xso['$ref']);
        let xso2 = getDefinitions(swagger)[nsName];
        return getNamespace(xso2, swagger);
    } else if (xso.xml) {
        return xso.xml.namespace;
    } else if (xso.items && xso.items.xml) {
        return xso.items.xml.namespace;
    }
    return 'NOT_FOUND';
}

/**
* @return all child properties of xso
*/
function getChildren(xso, swagger) {
    let children = [];
    if (xso['$ref']) {
        let nsName = getDefNameFromRef(xso['$ref']);
        let xso2 = getDefinitions(swagger)[nsName];
        return getChildren(xso2, swagger);
    } else if (xso.properties) {
        return Object.keys(xso.properties);
    } else if (xso.items) {
        return getChildren(xso.items, swagger);
    } else if (xso.allOf || xso.anyOf || xso.oneOf) {
        let list = xso.allOf || xso.anyOf || xso.oneOf;
        let length = xso.discriminator ? 1 : list.length;
        for (let i = 0; i < length; i++) {
            children = _.union(children, getChildren(list[i], swagger));
        }
        return children;
    }
    return children;
}

/**
* @param xso
* @param definitions section of yaml
* @param urlFormat if true then {ns}local , else prefix:local
* @return xsiType (prefix:name) of the xso
*/
function getXSIType(xso, definitions, urlFormat) {
    if (xso['$ref']) {
        let nsName = getDefNameFromRef(xso['$ref']);
        let xso2 = definitions[nsName];
        return getXSIType(xso2, definitions);
    } else if (xso['x-xsi-type'] && xso['x-xsi-type-xml']) {
        if (urlFormat) {
            if (xso['x-xsi-type-xml'].namespace) {
                return '{' + xso['x-xsi-type-xml'].namespace + '}' + xso['x-xsi-type'];
            } else {
                return xso['x-xsi-type'];
            }
        } else {
            if (xso['x-xsi-type-xml'].prefix) {
                return xso['x-xsi-type-xml'].prefix + ':' + xso['x-xsi-type'];
            } else {
                return xso['x-xsi-type'];
            }
        }
    }
    return 'NONE';
}

/**
* @return true if xso is an attribute
*/
function isAttribute(xso, swagger) {
    if (xso['$ref']) {
        let nsName = getDefNameFromRef(xso['$ref']);
        let xso2 = getDefinitions(swagger)[nsName];
        return isAttribute(xso2, swagger);
    } else if (xso.xml) {
        return xso.xml.attribute;
    }
    return false;
}


/**
* @param oldName is an NSName from an older (pre-dictionary improvement) swagger
* @param newSwagger is a post-dictionary improvement swagger.
* @return the heuristically calculated new name.
*/
function oldNSName2newNSName(oldName, newSwagger, preferType) {
    // Remove old typedef name mangling
    if (oldName.includes('typedef_')) {
        oldName = _.replace(oldName, 'typedef_', '_');
        preferType = true;
    }

    let newDefinitions = getDefinitions(newSwagger);
    if (newDefinitions[oldName]) {
        return oldName;
    }
    let names = _.split(oldName, '_for_');
    if (names.length > 2) {
        return null;
    }
    let suffix = '';
    if (names.length == 2) {
        let words = _.split(names[1], '_');
        if (words > 1 && words[1] != 'element') {
            words.splice(1, 0, 'element');
        }
        suffix = '_for_' + _.join(words, '_');
    }
    let kind = [ 'element', 'typedef', 'type', 'attribute', 'group', 'attributeGroup', 'substitutionGroup' ];
    let nsName = names[0];
    let words = _.split(nsName, '_');
    if (words.length === 1) {
        words.push('defaultTNS');
    }
    if (words.length > 1 && (kind.indexOf(words[1]) < 0)) {
        words.splice(1, 0, 'type');
        let nsNameType = _.join(words, '_');
        words[1] = 'typedef';
        let nsNameTypeDef = _.join(words, '_');
        words[1] = 'element';
        let nsNameElement = _.join(words, '_');

        preferType = preferType || words.length >= 3;
        if (!preferType) {
            if (newDefinitions[nsNameElement + suffix]) {
                return nsNameElement + suffix;
            }
            if (newDefinitions[nsNameElement]) {
                return nsNameElement;
            }
        }
        if (newDefinitions[nsNameType + suffix]) {
            return nsNameType + suffix;
        }
        if (newDefinitions[nsNameType]) {
            return nsNameType;
        }
        if (newDefinitions[nsNameTypeDef + suffix]) {
            return nsNameTypeDef + suffix;
        }
        if (newDefinitions[nsNameTypeDef]) {
            return nsNameTypeDef;
        }
        if (newDefinitions[nsNameElement + suffix]) {
            return nsNameElement + suffix;
        }
        if (newDefinitions[nsNameElement]) {
            return nsNameElement;
        }

        words = _.split(nsName, '_');
        if (words.length >= 3) {
            _.pullAt(words, words.length - 1);
            oldName = _.join(words, '_');
            if (names.length > 1) {
                oldName += '_for_' + names[1];
            }
            return oldNSName2newNSName(oldName, newSwagger, true);
        }
    }
    return null;
}

exports.r = r;
exports.RESTFUL_XML_URL = 'http://<REPLACE WITH XML REST URL>';
exports.addGetMethods = addGetMethods;
exports.addTestPaths = addTestPaths;
exports.addValidationErr = addValidationErr;
exports.addValidatePolicies = addValidatePolicies;
exports.checkAndFix = checkAndFix;
exports.checkGateway = checkGateway;
exports.cleanupDocumentation = cleanupDocumentation;
exports.convertToValidationErr = convertToValidationErr;
exports.countKeys = countKeys;
exports.deepClone = deepClone;
exports.deepCloneWithIgnoreKeys = deepCloneWithIgnoreKeys;
exports.detailMap = detailMap;
exports.disjointKeysToArray = disjointKeysToArray;
exports.extendObject = extendObject;
exports.fileNameFromPath = fileNameFromPath;
exports.findRefs = findRefs;
exports.getAncestorRefs = getAncestorRefs;
exports.getDefNameFromRef = getDefNameFromRef;
exports.getDescendents = getDescendents;
exports.getObjectName = getObjectName;
exports.getPrefixForNamespace = getPrefixForNamespace;
exports.getSubTypes = getSubTypes;
exports.getVersion = getVersion;
exports.getXSIType = getXSIType;
exports.inPolyHierarchy = inPolyHierarchy;
exports.isNCName = isNCName;
exports.isNMTOKEN = isNMTOKEN;
exports.isQName = isQName;
exports.makeOld = makeOld;
exports.makeSureItsAnArray = makeSureItsAnArray;
exports.makeValidationErr = makeValidationErr;
exports.oldNSName2newNSName = oldNSName2newNSName;
exports.parseToPrimitive = parseToPrimitive;
exports.portToV6Gateway = portToV6Gateway;
exports.randomAlphaString = randomAlphaString;
exports.removeDescription = removeDescription;
exports.removeKey = removeKey;
exports.removeNonUTF8Chars = removeNonUTF8Chars;
exports.replaceRefs = replaceRefs;
exports.setAsserts = setAsserts;
exports.shareObjects = shareObjects;
exports.shortenAllOfs = shortenAllOfs;
exports.slugifyName = slugifyName;
exports.squashAllOf = squashAllOf;
exports.stripNamespace = stripNamespace;
exports.traverse = traverse;
exports.traverseSwagger = traverseSwagger;
exports.traverseSchemaObjects = traverseSchemaObjects;
exports.useAsserts = useAsserts;
exports.wsAddrRelatedNamespace = wsAddrRelatedNamespace;
exports.wseRelatedNamespace = wseRelatedNamespace;
