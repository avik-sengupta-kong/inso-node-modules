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
* Valiate functions for the apiconnect-wsdl parser
**/

const u = require('../lib/utils.js');
const openApiV3 = require('../lib/openApiV3');
const rest = require('../lib/createRESTfromSOAP');


const q = require('q');
const swaggerParser = require('swagger-parser');
const util = require('util');
const d = require('../lib/domUtils.js');

// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');
const R = require('../lib/report.js');

var _ = require('lodash');

/**
 * Checks the swagger object for various problems.
 * Used in automated testing to help ensure that only valid swagger objects are produced.
 * Also used to analyze customer provided swaggers (which could be from old products or hand generated)
 * Return a promise
 */
async function sniffSwagger(swagger, flags) {
    flags = flags ? u.deepClone(flags) : {};
    let req = u.r(flags.req);
    let messageList = [];
    flags.level = flags.level || 'DETAIL';

    // Get any messages that have been obtained up to this point
    let initialMessages = R.getMessages(req, flags.level);

    // Create a new clean context
    req = u.deepClone(req);
    delete req.context;
    flags.req = req;

    // Check the whole swagger (root)
    flags.context = 'Root';
    messageList.push(await _sniffSwagger(u.deepClone(swagger), u.deepClone(flags)));

    // Independently check each embedded target swagger
    if (swagger['x-ibm-configuration'] && swagger['x-ibm-configuration'].targets) {
        for (let target in swagger['x-ibm-configuration'].targets) {
            flags.context = 'Target ' + target;
            let targetSwagger = u.deepClone(swagger['x-ibm-configuration'].targets[target]);
            u.replaceRefs(targetSwagger,
              [ { target: '#/',
                  source: '#/x-ibm-configuration/targets/' + target + '/' } ]);
            messageList.push(await _sniffSwagger(targetSwagger, u.deepClone(flags)));
        }
    }

    // Once all of the files are done, combine together
    let messages = {
        Initial: initialMessages,
    };
    for (let i = 0; i < messageList.length; i++) {
        if (messageList[i]) {
            _.merge(messages, messageList[i]);
        }
    }
    return messages;
}

async function _sniffSwagger(swagger, flags) {
    let req = flags.req;
    R.start(req, '_sniffSwagger');
    try {
        let isJSON = swagger['x-ibm-configuration'].type === 'wsdl-to-rest' ||
            swagger['x-ibm-configuration'].type === 'rest';

        // Look for the words in the swagger.
        // This is an indication that there is a problem.
        let text = util.inspect(swagger, {
            depth: null
        });
        let words = [
            'https://www.w3.org/2003/05/soap-envelope/', // Bad namespace
            'https://www.w3.org/2003/05/soap-envelope' // Bad namespace
        ];
        for (let w = 0; w < words.length; w++) {
            let word = words[w];
            let index = text.indexOf(word);
            if (index >= 0) {
                R.error(req, g.http(u.r(req)).f('Found illegal text (%s) in this api substring (%s).', word, text.substring(index - 100, index + 200)));
            }
        }

        // Check for very large files
        // Note this is in JSON format versus YAML format
        // The management node max size is about 16M
        if (text.length > 10000000) {
            R.warning(req, g.http(u.r(req)).f('The openapi file is %s characters long.', text.length));
        }

        // Count $ref, exceeding 4000 probably means that this won't publish
        let countRefs = (text.match(/\$ref/g) || []).length;
        if (countRefs > 4000) {
            R.warning(req, g.http(u.r(req)).f('The number of refs is %s.', countRefs));
        }

        // Excessive number of definitions may prevent publishing
        let numDefs = Object.keys(definitionsOrSchemas(swagger)).length;
        if (numDefs > 1000) {
            R.warning(req, g.http(u.r(req)).f('The number of openapi \'definition\' objects is %s.', numDefs));
        }

        // Detect excessive number of paths
        let numPaths = Object.keys(swagger.paths).length;
        if (numPaths > 100) {
            R.warning(req, g.http(u.r(req)).f('The number of openapi \'path\' objects is %s.', numPaths));
        }

        if (!isJSON) {
            findMissingPropertyIssues(swagger, req);
        }
        findPolyHierarchyProblems(definitionsOrSchemas(swagger), req);

        // Look for the old school APIC Messages in the swagger.
        // This is an indication that there is a problem.
        if (flags && flags.checkMessages) {
            let regex = /(APIC_MESSAGE[^)]*)/gi;
            let matches = text.match(regex);
            if (matches) {
                for (let i = 0; i < matches.length; i++) {
                    R.error(req, matches[i]);
                }
            }
            if (swagger['x-ibm-configuration'] &&
                swagger['x-ibm-configuration']['x-ibm-apiconnect-wsdl']) {
                let messages = swagger['x-ibm-configuration']['x-ibm-apiconnect-wsdl'].messages;
                if (messages.length > 0) {
                    let list = messages;
                    for (let i = 0; i < list.length; i++) {
                        let message = list[i].message;
                        if (list[i].$path) {
                            message = '(' + list[i].$path + ')' + message;
                        }
                        R.error(req, message);
                    }
                }
                if (messages.detail && messages.detail.length > 0) {
                    let list = messages.info;
                    for (let i = 0; i < list.length; i++) {
                        let message = list[i].message;
                        if (list[i].$path) {
                            message = '(' + list[i].$path + ')' + message;
                        }
                        R.detail(req, message);
                    }
                }
                if (messages.info && messages.info.length > 0) {
                    let list = messages.info;
                    for (let i = 0; i < list.length; i++) {
                        let message = list[i].message;
                        if (list[i].$path) {
                            message = '(' + list[i].$path + ')' + message;
                        }
                        R.info(req, message);
                    }
                }
                if (messages.warning && messages.warning.length > 0) {
                    let list = messages.warning;
                    for (let i = 0; i < list.length; i++) {
                        let message = list[i].message;
                        if (list[i].$path) {
                            message = '(' + list[i].$path + ')' + message;
                        }
                        R.warning(req, message);
                    }
                }
                if (messages.error && messages.error.length > 0) {
                    let list = messages.error;
                    for (let i = 0; i < list.length; i++) {
                        let message = list[i].message;
                        if (list[i].$path) {
                            message = '(' + list[i].$path + ')' + message;
                        }
                        R.error(req, message);
                    }
                }
            }
        }

        // Check example xml to ensure it is valid
        validateExampleXML(swagger, req);

        // Check for inconsistencies with array xmls
        findMismatchedArrays(swagger, req);

        // Check for missing or extra xml objects
        checkXMLObjects(swagger, req);

        // Check validity of xsos
        checkXSOs(swagger, req);

        // Find very deep inlines, which could indicate a problem.
        let context = {};
        findDeepInlines(swagger, context, isJSON, req);
        if (context.list) {
            for (let nsName in context.list) {
                if (!nsName.endsWith('Fault') &&
                    !nsName.endsWith('Input') &&
                    !nsName.endsWith('Output') &&
                     nsName != 'SubCode__SOAP12' &&
                     nsName != 'Security') {
                    R.info(req, g.http(u.r(req)).f('The \'definition\' %s has an inline depth of %s.', nsName, context.list[nsName]));
                }
            }
        }

        // Check gateway
        try {
            u.checkGateway(swagger, req);
        } catch (e) {
            R.error(req, e.message);
        }

        // Make sure each prefix is defined to a single namespace.
        let map = getNamespaces(swagger);
        for (let s in map) {
            for (let p in map[s]) {
                if (map[s][p].length > 1) {
                    R.warning(req, g.http(u.r(req)).f('Prefix %s has multiple namespaces %s.', p, map[s][p]));
                }
                // Look for inresting namespaces.
                for (let i = 0; i < map[s][p].length; i++) {
                    let ns = map[s][p][i];
                    // OASIS is an organization that defines industry schemas.
                    // Often these schemas use outlier schema constructs.
                    // And since OASIS defines industry schemas, these schemas are often used
                    // across companies.  Thus any strange constructs found in these schemas
                    // could not only span companies but also limit communication in an industry.
                    if (!u.wseRelatedNamespace(ns) &&
                        ns.indexOf('oasis') >= 0) {
                        R.info(req, g.http(u.r(req)).f('Prefix %s is bound to an OASIS namespace %s.', p, ns));
                    }
                }
            }
        }
        if (swagger.openapi && text.length > 50000) {
            R.info(req, g.http(u.r(req)).f('OAI V3 validation skipped because the swagger is larger than 50000 characters.'));
            let ret = {};
            ret[flags.context] = R.getMessages(req, flags.level);
            return ret;
        } else {
            await validateSwagger(swagger, req);
            R.end(req, '_sniffSwagger');
            let ret = {};
            ret[flags.context] = R.getMessages(req, flags.level);
            return ret;
        }
    } catch (e) {
        R.error(req, e);
        R.end(req, '_sniffSwagger', e);

        let ret = {};
        ret[flags.context] = R.getMessages(req, flags.level);
        return ret;
    }
}

/**
* Runs a validator against the swagger and returns a promise.
*/
function validateV3(swagger, req) {

    if (!openApiV3.isOpenApiV3Available()) {
        let validateDef = q.defer();
        validateDef.resolve();
        return validateDef.promise;
    }

    swagger = u.deepClone(swagger);
    replaceRefsWithStringType(swagger);

    if (swagger.openapi) {
        return openApiV3.validate(swagger, { req: req });
    }
    // In production, no validator is available
    let validateDef = q.defer();
    validateDef.resolve();
    return validateDef.promise;
}

/**
* Utility to replace refs with a string so that we can validate it quickly with sway.
*/
function replaceRefsWithStringType(swagger) {
    return u.traverse(swagger, function(obj) {
        if (obj && obj.$ref) {
            delete obj.$ref;
            obj.type = 'string';
        }
        return obj;
    });
}

/**
* Build a namespaces map of prefix->namespace for
* definitions and embedded services.
*/
function getNamespaces(swagger) {
    let service;
    let map = {};

    u.traverseSwagger(swagger, function(swagger) {
        service = swagger['x-ibm-configuration'] && swagger['x-ibm-configuration']['wsdl-definition'] ?
            swagger['x-ibm-configuration']['wsdl-definition'].service : undefined;
        return u.traverseSchemaObjects(swagger, function(xso) {
            if (service) {
                map[service] = map[service] || {};
                if (xso.xml && xso.xml.prefix) {
                    if (!map[service][xso.xml.prefix]) {
                        map[service][xso.xml.prefix] = [];
                    }
                    if (map[service][xso.xml.prefix].indexOf(xso.xml.namespace) < 0) {
                        map[service][xso.xml.prefix].push(xso.xml.namespace);
                    }
                }
            }
            return xso;
        });
    });
    return map;
}

/**
* Walk the object and find deep nestings of xso (xml schema objects).
* Deep nestings may indicate a problem with the generator or might indicate
* an usual shape of the input schema.
* While walking the object, other validation checks are also performed.
*/
function findDeepInlines(obj, context, isJSON, req) {
    let inRootXSO = context.inRootXSO;
    context.inRootXSO = false;
    if (Array.isArray(obj)) {
        for (let j = 0; j < obj.length; j++) {
            // recurse array element
            findDeepInlines(obj[j], context, isJSON, req);
        }
    } else if (obj && typeof obj === 'object') {
        for (let key in obj) {
            if (obj.hasOwnProperty(key)) {
                // allOf at the nsName level should be limited to 2.
                // Currently we only squash allOfs that are directly conained in the nsName definition
                if (key == 'allOf' && context.nsName && inRootXSO) {
                    if (obj.allOf.length >= 3) {
                        R.info(req, g.http(u.r(req)).f('An allOf with length: %s found in %s.  There are issues in the assembly tool with allOf with length greater than 2.',
                          obj.allOf.length,  context.nsName));
                    }
                }
                if (key == '$ref' && context.nsName) {
                    // There should be no other keys except for description
                    let keysExpected = obj.description ? 2 : 1;
                    let keys = Object.keys(obj);
                    if (keys.length > keysExpected) {
                        let msg = g.http(u.r(req)).f('Conflicting keys with \'$ref\': %s for %s.  Only \'description\' is allowed with \'$ref\'.', keys, context.nsName);
                        R.error(req, msg);
                    }
                }
                if (key == 'x-ibm-group' && context.nsName) {
                    let msg = g.http(u.r(req)).f('Detected x-ibm-group occurrence : %s within %s. ' +
                      'The occurrence of group, sequence, choice and all is only partially supported.', obj[key], context.nsName);
                    R.info(req, msg);
                }
                if (key == 'x-ibm-complex-restriction' && context.nsName) {
                    let msg = g.http(u.r(req)).f('Detected x-ibm-complex-restriction : %s within %s.', obj[key], context.nsName);
                    R.info(req, msg);
                }
                if (key == 'definitions'  || key == 'schemas') {
                    context.definitions = obj[key];
                    context.inDefinitions = true;
                    findDeepInlines(obj[key], context, isJSON, req);
                    context.inDefinitions = false;
                } else if (context.inDefinitions  && !context.nsName) {
                    context.nsName = key;
                    context.properties = 0;
                    context.inRootXSO = true;
                    // Make sure this definition has a xml construct
                    if (!isJSON && !obj[key].xml) {
                        // The parser probably should put out an xml construct for
                        // definitions for SOAP constructs, but it currently does not.
                        if (!(key.endsWith('Header') ||
                            key.endsWith('HeaderOut') ||
                            key.endsWith('Output') ||
                            key.endsWith('Input') ||
                            key.endsWith('Fault')  ||
                            key == 'APIC__RESERVED')) {
                            let msg = g.http(u.r(req)).f('No \'xml\' element found for definition %s.', key);
                            R.warning(req, msg);
                        }
                    }
                    findDeepInlines(obj[key], context, isJSON, req);
                    context.nsName = false;
                } else if (context.nsName && key == 'properties') {
                    if (Object.keys(obj[key]).length > 0) {
                        if (context.nsName) {
                            context.properties++;
                            if (context.properties >= 5) {
                                if (!context.list) {
                                    context.list = {};
                                }
                                context.list[context.nsName] = context.properties;
                            }
                        }
                        findDeepInlines(obj[key], context, isJSON, req);

                        if (context.nsName) {
                            context.properties--;
                        }

                    }
                } else {
                    findDeepInlines(obj[key], context, isJSON, req);
                }
            }
        }
    }
}

function checkXMLObjects(swagger, req) {
    let type = swagger['x-ibm-configuration'].type;
    u.traverseSchemaObjects(swagger, function(xso, nsName, context, path, stack) {
        let key = path.length > 0 ? path[path.length - 1] : undefined;
        let key2 = path.length > 1 ? path[path.length - 2] : undefined;

        if (xso.xml && xso.xml.namespace == null) {
            let msg = g.http(u.r(req)).f('An xml without a namespace was found within %s.  This may confuse the gateway.',
              nsName);
            R.warning(req, msg);
        }

        if (key && type === 'wsdl' && xso.type === 'array') {
            let special = key.endsWith('Header') ||
                key.endsWith('HeaderOut') ||
                key.endsWith('Output') ||
                key.endsWith('Input') ||
                key.endsWith('Fault')  ||
                key == 'APIC__RESERVED';
            if (context.isRoot) {
                if (special) {
                    // No check
                } else if (xso.type === 'array') {
                    // Allow but not necessary according to spec.
                    if (xso.xml && !xso.xml.name) {
                        let msg = g.http(u.r(req)).f('Extra xml found for array definition at root of %s.',
                          nsName);
                        R.info(req, msg);
                    }
                } else if (xso.$ref) {
                    // Unexpected
                    let msg = g.http(u.r(req)).f('A $ref was found at the root of %s.',
                      nsName);
                    R.warning(req, msg);
                } else {
                    if (!xso.xml) {
                        let msg =  g.http(u.r(req)).f('Missing xml at root of %s.',
                          nsName);
                        R.error(req, msg);
                    }
                }
            } else if (key2 === 'properties' || key === 'items') {
                if (xso.type === 'array') {
                    // Allow but not necessary according to spec.
                    if (xso.xml && !xso.xml.name) {
                        let msg = g.http(u.r(req)).f('Extra xml found for array definition embedded in %s.',
                          nsName);
                        R.info(req, msg);
                    }
                } else if (xso.$ref) {
                    // Acceptable
                } else {
                    if (!xso.xml) {
                        let msg =  g.http(u.r(req)).f('Missing xml embedded in %s.',
                          nsName);
                        R.error(req, msg);
                    }
                }
            } else {
                // Add message if there is an xml
                if (xso.xml && !xso.xml.name) {
                    let msg =  g.http(u.r(req)).f('Extra xml found for %s embedded in %s.',
                      key, nsName);
                    R.info(req, msg);
                }
            }
        }
        return xso;
    }, function(xso, nsName, context, path, stack) {
        let key = path.length > 1 ? path[path.length - 2] : undefined;
        if (context.isRoot) {
            if (!key) {
                type = swagger['x-ibm-configuration'].type;
            } else if (key === 'definitions') {
                type = stack[stack.length - 2]['x-ibm-configuration'].type;
            } else {
                type = stack[stack.length - 3]['x-ibm-configuration'].type;
            }
            if ((nsName.match(/_element_/g) || []).length > 1) {
                let msg =  g.http(u.r(req)).f('Name contains multiple element words (%s).',
                  nsName);
                R.warning(req, msg);
            }
        }
        return xso;
    });
}


function checkXSOs(swagger, req) {
    let KEYS = [ 'type', '$ref', 'allOf', 'oneOf', 'anyOf', 'x-anyType' ];
    let v3discriminator = swagger['x-ibm-configuration']['x-ibm-apiconnect-wsdl'] && swagger['x-ibm-configuration']['x-ibm-apiconnect-wsdl'].options ?
        swagger['x-ibm-configuration']['x-ibm-apiconnect-wsdl'].options.v3discriminator : false;
    u.traverseSchemaObjects(swagger, function(xso, nsName) {
        let keys = [];

        for (let i = 0; i < KEYS.length; i++) {
            if (xso[KEYS[i]]) {
                keys.push(KEYS[i]);
            }
        }

        if (keys.length === 0) {
            /* this is an empty element
            let msg = g.http(u.r(req)).f('Expected to find one of the following keys %s in %s:%s',
              KEYS, nsName, xso);
            R.error(req, msg);
            */
        } else if (keys.length > 1) {
            let msg = g.http(u.r(req)).f('The following key collision %s found in %s',
              keys, nsName);
            R.error(req, msg);
        }

        if (v3discriminator  && xso['x-ibm-discriminator']  && xso.discriminator) {
            let msg = g.http(u.r(req)).f('Unexpected discriminator field for %s',
              nsName);
            R.error(req, msg);
        }
        checkTypeAndFormat(xso, nsName, req);

        return xso;
    });
}

/**
* Log messages if problems detected with type and format settings
*/
function checkTypeAndFormat(xso, nsName, req) {
    if (!xso.type) {
        // It is okay to have no type, but in such cases there should be no format
        if (xso.format) {
            let msg = g.http(u.r(req)).f('Unexpected format %s on an xml schema object without a type found within %s',
              xso.format, nsName);
            R.error(req, msg);
        }
        return;
    }

    // Check for a type (and format) array.  If found, get the non-null type
    let type = xso.type;
    let format = xso.format;
    if (Array.isArray(type)) {
        // A type that is an array of values is supported by JSON Schema but not OAI.
        let msg = g.http(u.r(req)).f('A type with multiple values %s found within %s',
          JSON.stringify(type), nsName);

        if (type.length === 1) {
            type = type[0];
            if (Array.isArray(format)) {
                format = format[0];
            }
            R.info(req, msg);
        }
        if (type.length === 2 && _.indexOf(type, 'null') >= 0) {
            type = type[0] === 'null' ? type[1] : type[0];
            if (Array.isArray(format)) {
                format = type[0] === 'null' ? format[1] : format[0];
            }
            R.info(req, msg);
        } else {
            R.error(req, msg);
            return;
        }
    }

    // Check for valid type
    switch (type) {
    case 'null': {
        let msg = g.http(u.r(req)).f('A type: \'null\' is not supported by the Open API Specification. This type was found in %s.',
          type, nsName);
        R.error(req, msg);
        break;
    }
    case 'object':
    case 'array':
    case 'boolean':
        if (format) {
            let msg = g.http(u.r(req)).f('A type %s and format %s found within %s.  No format was expected.',
              type, format, nsName);
            R.error(req, msg);
        }
        break;
    case 'number': {
        let expected = [ 'float', 'double' ];
        if (!format) {
            // Allow a number without a format.  API Connect uses this for mapping 'decimal' and related types.
        } else if (!expected.includes(format)) {
            let msg = g.http(u.r(req)).f('Expected a format with value of %s but found %s for type %s within %s.',
              JSON.stringify(expected), format, type, nsName);
            R.error(req, msg);
        }
        break;
    }
    case 'integer': {
        let expected = [ 'int32', 'int64' ];
        if (!format) {
            let msg = g.http(u.r(req)).f('Expected a format for type %s within %s.',
              type, nsName);
            R.error(req, msg);
        } else if (!expected.includes(format)) {
            let msg = g.http(u.r(req)).f('Expected a format with value of %s but found %s for type %s within %s.',
              JSON.stringify(expected), format, type, nsName);
            R.error(req, msg);
        }
        break;
    }
    case 'string': {
        let expected = [ 'byte', 'binary', 'date', 'date-time',
            // "password", // A password is also acceptable, but it is not generated by apiconnect-wsdl
        ];
        if (format && !expected.includes(format)) {
            let msg = g.http(u.r(req)).f('Expected a format with value of %s but found %s for type %s within %s.',
              JSON.stringify(expected), format, type, nsName);
            R.info(req, msg); // Only an info message since there are a lot of alternative formats
        }
        break;
    }
    default:  {
        let msg = g.http(u.r(req)).f('Unexpected type %s and format %s within %s.',
          type, format, nsName);
        R.error(req, msg);
    }
    }
}


function findMismatchedArrays(swagger, req) {
    let defs;
    let type = swagger['x-ibm-configuration'].type;
    u.traverseSchemaObjects(swagger, function(xso, nsName, context, path, stack) {
        let key = path[path.length - 1];
        if (type === 'wsdl' && xso.type === 'array') {
            let xso2;
            if (xso.items) {
                if (xso.items.$ref) {
                    let nsName2 = u.getDefNameFromRef(xso.items.$ref);
                    xso2 = defs[nsName2];
                } else {
                    xso2 = xso.items;
                }
                // Expect to find an xml object within the items object since that is the xml
                // that is used for array namespaces.
                // However, in some situations the xml object is also repeated (for clarity)
                // at the same level as the items object.  In those cases, xml object must
                // be the same information.
                if (!xso2.xml) {
                    let msg = g.http(u.r(req)).f('Expected xml object within items while processing %s.',
                      nsName);
                    R.warning(req, msg);
                }
                if (xso.xml && xso2.xml &&
                    xso2.xml.namespace !== xso.xml.namespace) {
                    let msg = g.http(u.r(req)).f('Expected items namespace %s to be the same as the array namespace %s while processing %s in %s.',
                      xso2.xml.namespace, xso.xml.namespace, key, nsName);
                    R.error(req, msg);
                }
                if (xso.xml && xso.xml.wrapped) {
                    let msg = g.http(u.r(req)).f('The \'wrapped\' property is not supported.  The \'wrapped\' property was found while examining %s.',
                      nsName);
                    R.error(req, msg);
                }
            } else {
                let msg = g.http(u.r(req)).f('Expected items while processing %s.', nsName);
                R.warning(req, msg);
            }
        }
        return xso;
    }, function(xso, nsName, context, path, stack) {
        let key = path.length > 1 ? path[path.length - 2] : undefined;
        if (context.isRoot) {
            defs = stack[stack.length - 1];
            if (!key) {
                type = swagger['x-ibm-configuration'].type;
            } else if (key === 'definitions') {
                type = stack[stack.length - 2]['x-ibm-configuration'].type;
            } else {
                type = stack[stack.length - 3]['x-ibm-configuration'].type;
            }
        }
        return xso;
    });
}

function findMissingPropertyIssues(swagger, req) {
    let defs = definitionsOrSchemas(swagger);
    for (let nsName in defs) {
        let def = defs[nsName];
        if (def.allOf && def.allOf.length > 0 && def.allOf[0].$ref) {
            let nsName2 = u.getDefNameFromRef(def.allOf[0].$ref);
            let def2 = defs[nsName2];
            if (!def.xml) {
                R.warning(req, g.http(u.r(req)).f('Missing xml object on %s.', nsName));
            }
            if (!def2) {
                R.error(req, g.http(u.r(req)).f('Missing xso %s. in %s.', nsName2, nsName));
                continue;
            }
            if (!def2.xml) {
                R.warning(req, g.http(u.r(req)).f('Missing xml object on %s.', nsName2));
            }
            // Make sure all of the def2 properties have an xml
            if (def2.properties) {
                for (let propName in def2.properties) {
                    let prop = def2.properties[propName];
                    if (prop.type === 'array') {
                        prop = prop.items;
                    }
                    if (!prop.$ref && !prop.xml) {
                        if (def.xml.namespace != def2.xml.namespace) {
                            R.error(req, g.http(u.r(req)).f('Property %s in %s has no xml and this could be a problem because it is referenced in %s .', propName, nsName2, nsName));
                        }
                    }
                }
            }
            if (def2.allOf) {
                for (let i = 0; i < def2.allOf.length; i++) {
                    let allOf = def2.allOf[i];
                    if (allOf.properties) {
                        for (let propName in allOf.properties) {
                            let prop = allOf.properties[propName];
                            if (prop.type === 'array') {
                                prop = prop.items;
                            }
                            if (!prop.$ref && !prop.xml) {
                                if (def.xml.namespace != def2.xml.namespace) {
                                    R.error(req, g.http(u.r(req)).f('Property %s in %s has no xml and this could be a problem because it is referenced in %s .', propName, nsName2, nsName));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
* ValidateSwagger with the swaggerParser
*/
async function validateSwagger(swagger, req) {
    if (swagger.openapi) {
        return validateV3(swagger, req);
    }
    // Unfortunately the parser can hang if there are certain kinds of circular references.
    // Disabling circular references does not seem to work.
    // As a work around replace refs with string types.
    swagger = u.deepClone(swagger);
    replaceRefsWithStringType(swagger);
    try {
        await swaggerParser.validate(swagger, {
            allow: {
                unknown: false,
                empty: false
            },
            $refs: {
                external: false
            },
            validate: {
                // spec: true
            }
        });
    } catch (err) {
        let returnError = '';
        let lines = err.message.match(/[^\r\n]+/g);
        for (let i = 1; i < lines.length; i++) {
            // Prune silly stuff
            let line = lines[i];
            if (line.indexOf('Expected type number but found type string') >= 0 ||
                line.indexOf('JSON_OBJECT_VALIDATION_FAILED') >= 0 ||
                line === ' ') {
                // Accept
            } else {
                returnError = returnError + line + '\n';
            }
        }
        if (returnError.length > 0) {
            returnError = lines[0] + '\n' + returnError; // Add error message header line
            throw new Error(returnError);
        }
    }
}

/**
* Find the examples (which are xml) and validate them with a DOMParser.
* Errors in the examples may indicate problems in the generation code
* because the example generator walks the swagger to produce the example.
*/
function validateExampleXML(swagger, req) {
    let totalLength = 0;
    try {
        let ds = definitionsOrSchemas(swagger);
        if (ds) {
            for (let nsName in ds) {
                let def = ds[nsName];
                let xml = def.example;
                if (xml) {
                    if (xml.length < 10000) {
                        try {
                            d.loadSafeDOM(xml, req);
                        } catch (err) {
                            R.error(req, err);
                        }
                    } else {
                        totalLength += xml.length;
                    }
                }
            }
            if (totalLength > 1000000) {
                let msg =  g.http(u.r(req)).f('Excessive number of example characters %s.', totalLength);
                R.error(req, msg);
            }
        }
    } catch (e) {
        R.error(req, 'validate example: ' + e);
    }
}

/**
* @returns definitions (V2) or components.schemas (V3)
*/
function definitionsOrSchemas(swagger) {
    let d;
    if (swagger.openapi) {
        d = swagger.components ? swagger.components.schemas : null;
    } else {
        d = swagger.definitions;
    }
    return d || {};
}

function findPolyHierarchyProblems(definitions, req) {
    // Get ref counts
    let map = u.findRefs(definitions);
    let subTypes = u.getSubTypes(definitions);
    let hierarchyMap = {};

    for (let nsName in definitions) {
        let def = definitions[nsName];
        let anc = u.getAncestorRefs(definitions, nsName, req);
        // If in a poly hierarchy that is referenced and this is a type that is polymorphic (x-ibm-discriminator)
        if (u.inPolyHierarchy(definitions, nsName, anc, map) && def['x-ibm-discriminator']) {
            // If in a poly hierarchy, the unique name must be unique to that hierarchy
            if (!def['x-xsi-type-uniquename']) {
                R.warning(req, g.http(u.r(req)).f('x-xsi-type-uniquename of %s is not set.', nsName));
            }
            let descendents = u.getDescendents(nsName, subTypes);
            if (descendents.length > 20) {
                R.detail(req, g.http(u.r(req)).f('Large Hierarchy for %s containing %s.', nsName, descendents));
            }

            // Make sure the hierarchy maps are the same for each logical type
            let xsiType = def['x-xsi-type-xml'] ? def['x-xsi-type-xml'].prefix + ':' + def['x-xsi-type'] : null;
            let ancTypes = [];
            let nullable = def['x-nullable'] || def['nullable'] || false;
            if (anc) {
                for (let i = 0; i < anc.length; i++) {
                    let ancDefName = u.getDefNameFromRef(anc[i]);
                    if (definitions[ancDefName]) {
                        let xsiType2 = definitions[ancDefName]['x-xsi-type-xml'] ? definitions[ancDefName]['x-xsi-type-xml'].prefix + ':' + definitions[ancDefName]['x-xsi-type'] : null;
                        if (xsiType2) {
                            if (ancTypes.indexOf(xsiType2) >= 0) {
                                R.warning(req, g.http(u.r(req)).f('Duplicate xsi types found in ancestor hierarchy of %s.  Processing %s with type %s. ', nsName, ancDefName, xsiType2));
                            }
                            ancTypes.push(xsiType2);
                        }
                        let nullable2 = definitions[ancDefName]['x-nullable'] || definitions[ancDefName]['nullable'] || false;
                        if (nullable !== nullable2) {
                            R.warning(req, g.http(u.r(req)).f('Conflicting nullable setting for ancestor %s of %s: %s and %s', ancDefName, nsName, nullable2, nullable));
                        }
                    }
                }
            }
            let descTypes = [];
            if (descendents) {
                for (let i = 0; i < descendents.length; i++) {
                    let descDefName = descendents[i];
                    if (definitions[descDefName]) {
                        let xsiType2 = definitions[descDefName]['x-xsi-type-xml'] ? definitions[descDefName]['x-xsi-type-xml'].prefix + ':' + definitions[descDefName]['x-xsi-type'] : null;
                        if (xsiType2) {
                            if (descTypes.indexOf(xsiType2) >= 0) {
                                R.warning(req, g.http(u.r(req)).f('Duplicate xsi types found in descendent hierarchy of %s.  Processing %s with type %s. ', nsName, descDefName, xsiType2));
                            }
                            descTypes.push(xsiType2);
                        }
                        let nullable2 = definitions[descDefName]['x-nullable'] || false;
                        if (nullable !== nullable2) {
                            R.warning(req, g.http(u.r(req)).f('Conflicting nullable setting for descendent %s of %s: %s and %s', descDefName, nsName, nullable2, nullable));
                        }
                    }
                }
            }
            descTypes.sort();
            if (xsiType) {
                if (hierarchyMap[xsiType]) {
                    if (JSON.stringify(ancTypes) !== JSON.stringify(hierarchyMap[xsiType].ancTypes)) {
                        R.warning(req, g.http(u.r(req)).f('Inconsistent ancestor hierarchy between %s and %s: %s and %s', nsName, hierarchyMap[xsiType].from, ancTypes, hierarchyMap[xsiType].ancTypes));
                    }
                    if (JSON.stringify(descTypes) !== JSON.stringify(hierarchyMap[xsiType].descTypes)) {
                        R.warning(req, g.http(u.r(req)).f('Inconsistent descendent hierarchy between %s and %s: %s and %s', nsName, hierarchyMap[xsiType].from, descTypes, hierarchyMap[xsiType].descTypes));
                    }
                } else {
                    hierarchyMap[xsiType] = { ancTypes: ancTypes, descTypes: descTypes, from: nsName };
                }
            }
        }
    }
}


exports.getNamespaces = getNamespaces;
exports.sniffSwagger = sniffSwagger;
exports.replaceRefsWithStringType = replaceRefsWithStringType;
