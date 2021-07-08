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

/**
* Example generation functions for the apiconnect-wsdl parser
**/
const u = require('../lib/utils.js');
const util = require('util');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');
const R = require('../lib/report.js');

/**
* Generate all the examples that were tagged in the dictionary.
*/
function generateExamples(swagger, req) {
    let detailMap;
    try {
        detailMap = u.detailMap(swagger, req);
    } catch (e) {
        // Silently continue if detail map not available.
    }
    for (let nsName in swagger.definitions) {
        let xso = swagger.definitions[nsName];
        if (xso.example) {
            try {
                let xmlSample = exampleXMLForType(nsName, swagger.definitions, detailMap, req);
                if (xmlSample) {
                    swagger.definitions[nsName].example = xmlSample;
                }
            } catch (e) {
                R.error(req, e.message);
            }
        }
    }
    // If excessive examples, silently remove them to avoid exceeding the api limit
    let totalLength = 0;
    for (let nsName in swagger.definitions) {
        if (swagger.definitions[nsName].example) {
            totalLength += swagger.definitions[nsName].example.length;
        }
    }
    if (totalLength > 1000000) {
        for (let nsName in swagger.definitions) {
            if (swagger.definitions[nsName].example) {
                delete swagger.definitions[nsName].example;
            }
        }
    }
}

function exampleXMLForType(nsName, definitions, detailMap, req) {
    let xso = definitions[nsName];
    let nsStack = [];
    let ret = '';
    let context = {
        nesting: 0,
        propertyCount: 0,
        nestingLimit: 10,
        breadthLimit: 50,
        detailMap: detailMap
    };
    if (xso) {
        if (xso.properties && xso.properties.Envelope) {
            push(nsStack, xso.xml);
            context.topSOAP = true;
            ret = generateElement('Envelope', xso.properties.Envelope, definitions, nsStack, context, false, req);
            pop(nsStack);
        } else {
            ret = generateElement(xso.xml.name, xso, definitions, nsStack, context, false, req);
        }
    }
    return ret;
}
function generateElement(name, xso, definitions, nsStack, context, inOneOf, req) {
    if (xso.$ref) {
        xso = getRefXSO(xso.$ref, definitions, req);
    }
    if (xso.type === 'array') {
        context.occurrenceComment = getOccurrenceComment(xso, inOneOf);
        xso = xso.items;
        if (xso.$ref) {
            xso = getRefXSO(xso.$ref, definitions, req);
        }
        push(nsStack, xso.xml);
        let ret = generateElement(name, xso, definitions, nsStack, context, inOneOf, req);
        pop(nsStack);
        context.occurrenceComment = null;
        return ret;
    } else {
        if (context.nesting > context.nestingLimit) {
            return '<!-- schema nesting too deep, truncated example -->';
        }
        let padding = padString(context.nesting);
        context.nesting++;
        push(nsStack, xso.xml);
        let xml = getXML(nsStack);
        name = xml.name || name;
        let tagName = name;
        if (xml.prefix && xml.prefix.length > 0) {
            tagName = xml.prefix + ':' + name;
        }

        // Use the xso to detect xso
        xml.breadCrumb = xso;
        if (detectCycle(nsStack)) {
            pop(nsStack);
            context.nesting--;
            return '\n' + padding + '<' + tagName + '>Cycle detected, further nesting not shown</' + tagName + '>';
        }

        let comment = '';
        if (context.isRequired && !isSOAPNamespace(xml.namespace)  && !inOneOf) {
            comment += '<!-- mandatory -->';
        }
        if (context.occurrenceComment) {
            comment += context.occurrenceComment;
        }
        context.occurrenceComment = null;
        context.requiredComment = null;

        let nsDeclarations = '';
        if (context && context.topSOAP) {
            context.topSOAP = false;
            nsDeclarations = ' xmlns:' + xml.prefix + '="' + xml.namespace + '"';
        } else {
            if (triggerNSDeclarations(nsStack)) {
                let map = {};
                buildPrefixMap(xso, definitions, map, null, req);
                let prefixes = Object.keys(map).sort();
                for (let i = 0; i < prefixes.length; i++) {
                    nsDeclarations += ' xmlns:' + prefixes[i] + '="' + map[prefixes[i]] + '"';
                }
            }
        }
        let attrs = getAttributes(xso, definitions, {}, req);
        let primitiveContent = getPrimitiveContent(xso, definitions, req);
        let content = primitiveContent || getContent(xso, definitions, nsStack, context, false, req) || '';

        pop(nsStack);
        context.nesting--;
        context.propertyCount++;
        if (context.propertyCount > 200) {
            context.breadthLimit = 5;
        }

        // If this is a polymorphic type, then add an xsi:type and comment
        let xsiType = '';
        if (context.detailMap) {
            let t = u.getXSIType(xso, definitions);
            if (t !== 'NONE' && context.detailMap.polyTypes[t]) {
                xsiType = ' xsi:type=\"' + t + '\"';
                if (context.detailMap.polyTypes[t]) {
                    comment += '<!-- Other values of xsi:type ' + context.detailMap.polyTypes[t] + ' -->';
                }
            }
        }

        // Put the attrs before the ns declarations if this is the top
        // element.  We only do this so that it is easier to diff
        // with older versions of the parser.
        let startTag = (context.nesting === 0) ?
            '<' + tagName + xsiType + attrs + nsDeclarations + '>' :
            '<' + tagName + xsiType + nsDeclarations + attrs + '>';
        let endTag = '</' + tagName + '>';

        // If the comment contains the nesting comment and no other nesting,
        // force onto one line because it makes it easier to diff against older versions
        // of the parser.
        let special = (content.indexOf('<!-- schema nesting too deep, truncated example -->') >= 0 &&
            content.indexOf('\n') < 0);

        // The ws-security Security header is always generated with the wsse prefix
        // Provide an instructional comment to users.
        let preComment = '';
        if (tagName === 'wsse:Security') {
            preComment = '\n' + padding + '<!-- The Security element should be removed if WS-Security is not enabled on the SOAP target-url -->';
        }

        if (context.nesting > 0 &&
            (primitiveContent ||
            content.length === 0 ||
            special)) {
            // Generate on a single line
            return preComment + '\n' + padding + startTag + comment + content + endTag;
        } else {
            // Generate on multiple lines
            return preComment + '\n' + padding + startTag + comment + content + '\n' + padding + endTag;
        }
    }
}

function detectCycle(nsStack) {
    let xml = getXML(nsStack);
    if (!xml || !xml.breadCrumb) {
        return false;
    }
    for (let i = 0; i < nsStack.length - 1; i++) {
        if (nsStack[i].breadCrumb === xml.breadCrumb) {
            return true;
        }
    }
    return false;
}

function padString(count) {
    let ret = '';
    for (let i = 0; i < count; i++) {
        ret += ' ';
    }
    return ret;
}

function push(nsStack, xml) {
    if (!xml) {
        // If no xml provided, use the ns/prefix on the top of the stack
        xml = getXML(nsStack) || {};
        xml = u.deepClone(xml);
        xml.name = null;
    }
    nsStack.push(u.deepClone(xml));
}
function pop(nsStack) {
    if (nsStack.length > 0) {
        nsStack.pop();
    }
}

function getXML(nsStack) {
    if (nsStack.length > 0) {
        return nsStack[nsStack.length - 1];
    } else {
        return null;
    }
}

function triggerNSDeclarations(nsStack) {
    if (!nsStack || nsStack.length == 0) {
        return false;
    } else {
        let last = nsStack.length - 1;
        if (nsStack[last].namespace &&
            nsStack[last].namespace.length > 0 &&
            !isSOAPNamespace(nsStack[last].namespace)) {
            for (let i = 0; i < last; i++) {
                if (nsStack[i].namespace &&
                    nsStack[i].namespace.length > 0 &&
                   !isSOAPNamespace(nsStack[i].namespace)) {
                    return false;
                }
            }
            return true;
        }
        return false;
    }
}

function isSOAPNamespace(ns) {
    return ns === 'http://www.w3.org/2003/05/soap-envelope' ||
           ns === 'http://schemas.xmlsoap.org/soap/envelope/';
}

function getContent(xso, definitions, nsStack, context, inOneOf, req) {
    let primitive = getPrimitiveContent(xso, definitions, req);
    if (primitive) {
        return primitive;
    } else if (xso.allOf) {
        return getAllOfContent(xso, definitions, nsStack, context, inOneOf, req);
    } else if (xso.oneOf) {
        return getOneOfContent(xso, definitions, nsStack, context, inOneOf, req);
    } else if (xso.type === 'object') {
        return getObjectContent(xso, definitions, nsStack, context, inOneOf, req);
    }
}

function getOccurrenceComment(xso, inOneOf) {
    let minItems = xso.minItems ? xso.minItems : 'zero';
    let maxItems = xso.maxItems ? xso.maxItems : 'unlimited';
    if (inOneOf) {
        minItems = 'zero';
    }
    return '<!-- between ' + minItems + ' and ' + maxItems + ' repetitions of this element -->';
}

function getAllOfContent(xso, definitions, nsStack, context, inOneOf, req) {
    let ret = '';
    if (xso.allOf) {
        for (let i = 0; i < xso.allOf.length; i++) {
            let allOfXSO = xso.allOf[i];
            if (allOfXSO.$ref) {
                allOfXSO = getRefXSO(allOfXSO.$ref, definitions, req);
            }
            push(nsStack, allOfXSO.xml);
            ret += getContent(allOfXSO, definitions, nsStack, context, inOneOf, req);
            pop(nsStack);
        }
    }
    return ret;
}

function getOneOfContent(xso, definitions, nsStack, context, inOneOf, req) {
    let ret = '';
    if (xso.oneOf) {
        // If the oneOf is for a discriminator, then only process the first one.
        let length = xso.discriminator ? 1 : xso.oneOf.length;
        if (length > 1) {
            ret += '\n' + padString(context.nesting) + '<!-- choice start: set one of the following elements and remove the other elements -->';
        }
        for (let i = 0; i < length; i++) {
            let oneOfXSO = xso.oneOf[i];
            if (oneOfXSO.$ref) {
                oneOfXSO = getRefXSO(oneOfXSO.$ref, definitions, req);
            }
            push(nsStack, oneOfXSO.xml);
            ret += getContent(oneOfXSO, definitions, nsStack, context, !xso.discriminator, req);
            pop(nsStack);
        }
        if (length > 1) {
            ret += '\n' + padString(context.nesting) + '<!-- choice end -->';
        }
    }
    return ret;
}

function getObjectContent(xso, definitions, nsStack, context, inOneOf, req) {
    let ret = '';
    let breadth = 0;
    let breadthLimit = context.breadthLimit;
    let choiceComment;
    if (xso.properties) {
        for (let propName in xso.properties) {
            let propXSO = xso.properties[propName];
            if (!isAttribute(propXSO, definitions, req)) {
                context.isRequired = isRequired(propName, xso.required);
                if (breadth >= breadthLimit) {
                    ret += '\n' + padString(context.nesting) + '<!-- Number of properties exceeds ' + breadthLimit + ', truncated example -->';
                    break;
                }
                if (propXSO['x-ibm-basic-choice'] !== choiceComment) {
                    if (choiceComment) {
                        ret += '\n' + padString(context.nesting) + '<!-- choice end -->';
                    }
                    choiceComment = propXSO['x-ibm-basic-choice'];
                    if (choiceComment) {
                        ret += '\n' + padString(context.nesting) + '<!-- choice start: set one of the following elements and remove the other elements -->';
                    }
                }
                ret += generateElement(propName, propXSO, definitions, nsStack, context, inOneOf, req);
                breadth++;
                if (context.nesting > context.nestingLimit) {
                    break;
                }
            }
        }
        if (choiceComment) {
            ret += '\n' + padString(context.nesting) + '<!-- choice end -->';
        }
    }
    return ret;
}

function isRequired(propName, requiredList) {
    var ret = false;
    if (requiredList && propName) {
        if (requiredList.indexOf(propName) != -1) {
            ret = true;
        }
    }
    return ret;
}

function getAttributes(xso, definitions, prefixes, req) {
    let ret = '';
    if (xso && xso.$ref) {
        xso = getRefXSO(xso.$ref, definitions, req);
    }

    if (xso) {
        ret += getAttributesOfProperties(xso.properties, definitions, prefixes, req);
        if (xso.allOf || (xso.oneOf && xso.discriminator)) {
            let list = xso.allOf || xso.oneOf;
            let length = xso.discriminator ? 1 : list.length;
            for (let i = 0; i < length; i++) {
                let item = list[i];
                ret += getAttributes(item, definitions, prefixes, req);
                if (ret.length > 10000) {
                    throw g.http(u.r(req)).Error('The number of attributes on an element exceeded 10000.  This schema is too complex.');
                }
            }
        }
    }
    return ret;
}


function getAttributesOfProperties(properties, definitions, prefixes, req) {
    let ret = '';
    if (properties) {
        for (let propName in properties) {
            let prop = properties[propName];
            if (prop['$ref']) {
                prop = getRefXSO(prop.$ref, definitions, req);
            }
            if (prop.xml && prop.xml.attribute) {
                let value = getPrimitiveContent(prop, definitions, req);
                let shortName = prop.xml.name ? prop.xml.name : propName;
                let name = shortName;
                // The assumption is that attributes always have an xml object
                // or are unqualified.  If this assumption changes, then
                // we will need to pass down the nsStack.
                if (prop.xml.prefix && prop.xml.prefix != '') {
                    var prefix = prop.xml.prefix;
                    name = prefix + ':' + shortName;
                    if (prefix != 'xml') { // xml is special and doesn't have a namespace
                        if (!prefixes[prefix] && prop.xml.namespace) {
                            prefixes[prefix] = prop.xml.namespace;
                        }
                    }
                }
                var attr = ' ' + name + '="' + value + '"';
                ret += attr;
            }
        }
    }
    return ret;
}

function isAttribute(xso, definitions, req) {
    if (xso && xso.$ref) {
        xso = getRefXSO(xso.$ref, definitions, req);
    }
    return xso && xso.xml && xso.xml.attribute;
}

function getPrimitiveContent(xso, definitions, req) {
    let ret = null; // Assume not primitive
    if (xso && xso.$ref) {
        xso = getRefXSO(xso.$ref, definitions, req);
    }

    // If there is an allof or anyOf or oneOf, then assume primitive content if any of the allOfTypes are primitive
    if (xso.allOf || xso.oneOf || xso.anyOf) {
        let list = xso.allOf || xso.oneOf || xso.anyOf;
        let length = xso.discriminator ? 1 : list.length;
        for (let i = 0; i < length; i++) {
            let prim = getPrimitiveContent(list[i], definitions, req);
            if (prim) {
                return prim;
            }
        }
        return null;
    } else {
        switch (xso.type) {
        case 'integer':
            ret = '3';
            break;
        case 'number':
            if (xso.format && (xso.format == 'float' || xso.format == 'double')) {
                ret = '3.14';
            } else if (typeof xso.maximum !== 'undefined') {
                ret = '' + (xso.maximum - 3);
            } else if (typeof xso.minimum !== 'undefined') {
                ret = '' + (xso.minimum + 3);
            } else {
                ret = '3';
            }
            break;
        case 'boolean':
            ret = 'true';
            break;
        case 'string':
            if (xso.format) {
                switch (xso.format) {
                case 'byte':
                    ret = '3';
                    break;
                case 'binary':
                    ret = 'abcd';
                    break;
                case 'date':
                    ret = '2016-04-18';
                    break;
                case 'date-time':
                    ret = '2016-04-18T14:07:37';
                    break;
                default:
                    ret = 'string';
                    break;
                } // end for
            } else {
                ret = 'string';
            }
            break;
        case undefined:  // special case for empty element
            ret = 'string';
            break;
        default:
            if (xso.xml && xso.xml.namespace === 'http://www.w3.org/2001/XMLSchema') {
                // special case for schema reference
                ret = '<!--schema-->';
            }
        }
    }
    return ret;
}


function getRefXSO(ref, definitions, req) {
    let lastSlash = ref.lastIndexOf('/');
    let nsName = ref.substr(lastSlash + 1);
    let firstUnderscore = nsName.indexOf('_');
    let lastUnderscore = nsName.lastIndexOf('_');
    let prefix = nsName.substr(lastUnderscore + 1);
    let name = firstUnderscore > 0 ? nsName.substr(0, firstUnderscore) : nsName;
    let xso = definitions[nsName];
    if (!xso) {
        throw g.http(u.r(req)).Error('The reference %s does not exist. This may indicate that the schema associated with prefix %s was not provided or did not contain the referenced name %s.', ref, prefix, name);
    }
    return xso;
}

function buildPrefixMap(xso, definitions, map, uniqueRefs, req) {
    uniqueRefs = uniqueRefs || [];
    if (xso) {
        if (xso.$ref) {
            if (uniqueRefs.indexOf(xso.$ref) > -1) {
                return; // Already visited
            }
            uniqueRefs.push(xso.$ref);
            xso = getRefXSO(xso.$ref, definitions, req);
        }
        if (xso.allOf) {
            for (let i = 0; i < xso.allOf.length; i++) {
                buildPrefixMap(xso.allOf[i], definitions, map, uniqueRefs, req);
            }
        }
        if (xso.oneOf) {
            let length = xso.discriminator ? 1 : xso.oneOf.length;
            for (let i = 0; i < length; i++) {
                buildPrefixMap(xso.oneOf[i], definitions, map, uniqueRefs, req);
            }
        }
        if (xso.anyOf) {
            for (let i = 0; i < xso.anyOf.length; i++) {
                buildPrefixMap(xso.anyOf[i], definitions, map, uniqueRefs, req);
            }
        }
        addPrefixToMap(xso.xml, map);
        if (xso.properties) {
            for (let propName in xso.properties) {
                buildPrefixMap(xso.properties[propName], definitions, map, uniqueRefs, req);
            }
        }
        if (xso.type === 'array') {
            buildPrefixMap(xso.items, definitions, map, uniqueRefs, req);
        }
    }
}

function addPrefixToMap(xml, map) {
    if (xml) {
        if (xml.prefix && xml.prefix.length > 0) {
            if (!map[xml.prefix] && xml.prefix != 'xml') {
                map[xml.prefix] = xml.namespace;
            }
        }
    }
}

exports.generateExamples = generateExamples;
