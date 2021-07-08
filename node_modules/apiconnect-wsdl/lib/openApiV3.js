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
* Utilities to update from Open API V2 to V3
**/

const u = require('../lib/utils.js');
const copts = require('../lib/createOptions.js');
const postgen = require('../lib/postGenerate.js');

const q = require('q');
const util = require('util');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');

// The swagger2openapi is the defacto conversion package
var swagger2openapi = null;
var oasvalidator = null;
try {
    swagger2openapi = require('swagger2openapi');
    oasvalidator = require('oas-validator');
} catch (e) {
    swagger2openapi = null;
    oasvalidator = null;
}

/**
* Conversion is only available if the converter code is included
*/
function isOpenApiV3Available() {
    return swagger2openapi !== null  && oasvalidator !== null;
}

/**
* Converts the swagger (and embedded swaggers to Open API V3)
* @param swagger
* @param createOptions
* @returns a promise containing the Open API V3 of the swagger
*/
async function getOpenApiV3(swagger, createOptions) {
    createOptions = copts.validate(createOptions);
    let req = createOptions.req;

    // Assume that if root swagger is V3 then the embedded ones are too.
    if (swagger.openapi >= 3) {
        return swagger;
    }

    if (!isOpenApiV3Available()) {
        throw g.http(u.r(req)).Error('Open api v3 conversion is unavailable.');
    }

    let s2oaOptions = { patch: true };
    let xibmconfig = [ swagger['x-ibm-configuration'] ];
    swagger['x-ibm-configuration'] = '';
    let s2oaResult = await swagger2openapi.convertObj(swagger, s2oaOptions);
    swagger = s2oaResult.openapi;
    fixOAI3(swagger);
    swagger['x-ibm-configuration'] = xibmconfig.pop();
    if (swagger['x-ibm-configuration'].targets) {
        // Convert all of the inner swaggers
        let title2key = {};
        let s2oaInnerResults = [];
        for (let key in swagger['x-ibm-configuration'].targets) {
            let inner = u.deepClone(swagger['x-ibm-configuration'].targets[key]);
            // Replace the nested references with root references prior to the conversion
            u.replaceRefs(inner,
              [ { source: '#/x-ibm-configuration/targets/' + key + '/',
                  target: '#/' } ]);
            title2key[inner.info.title] = key;
            xibmconfig.push(inner['x-ibm-configuration']);
            inner['x-ibm-configuration'] = '';
            let innerSwagger = await swagger2openapi.convertObj(inner, s2oaOptions);
            fixOAI3(innerSwagger);
            s2oaInnerResults.push(innerSwagger);
        }
        for (let i = 0; i < s2oaInnerResults.length; i++) {
            let key = title2key[s2oaInnerResults[i].openapi.info.title];
            // Replace the root references with nested references
            u.replaceRefs(s2oaInnerResults[i].openapi,
              [ { source: '#/',
                  target: '#/x-ibm-configuration/targets/' + key + '/' } ]);
            swagger['x-ibm-configuration'].targets[key] = s2oaInnerResults[i].openapi;
            swagger['x-ibm-configuration'].targets[key]['x-ibm-configuration'] = xibmconfig[i];
        }
        // Finally replace any remaining references (in the assembly) with the new references
        u.replaceRefs(swagger,
          [ { source: '/definitions/',
              target: '/components/schemas/' } ]);
    }
    // The converter may remove xml.namespace if set to ''.
    // The c14nXMLObjects function will add the namespace back.
    swagger = postgen.c14nXMLObjects(swagger, true);

    // The c14nxso will ensure that the fields within the xso are in a consistent order.
    swagger = postgen.c14nxso(swagger, req, createOptions.v3nullable);
    return swagger;
}

/**
* Fix any conversion errors produced by swagger2openapi
* @param swagger
*/
function fixOAI3(swagger) {
    // swagger2openapi creates a common definition for repeated request bodies.
    // Unfortunately this breaks the validator.
    // This is a quick in-place fix to detect and 'outline' the change.
    for (let path in swagger.paths) {
        if (swagger.paths[path].post &&
            swagger.paths[path].post.requestBody &&
            swagger.paths[path].post.requestBody.$ref) {
            let def = getRef(swagger, swagger.paths[path].post.requestBody.$ref);
            if (def) {
                swagger.paths[path].post.requestBody = u.deepClone(def);
            }
        }
    }
}

/**
* @param swagger
* @param ref values
* @return return the referenced object/definition
*/
function getRef(swagger, ref) {
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

/**
* Validate the swagger and embedded swagger with the swagger2openapi (oas-validator) validator
*/
function validate(swagger, options) {
    options = options || {};
    let req = options.req;
    if (!isOpenApiV3Available()) {
        let def = q.defer();
        def.reject(g.http(u.r(req)).Error('Open api v3 conversion is unavailable.'));
        return def.promise;
    }

    swagger = u.deepClone(swagger);
    changeNamespaces(swagger);

    // Validate the whole swagger, then validate any embedded swaggers.
    let promises = [];
    promises.push(_validate(swagger, null, req));
    for (let target in swagger['x-ibm-configuration'].targets) {
        promises.push(_validate(swagger['x-ibm-configuration'].targets[target], target, req));
    }
    return Promise.all(promises);
}

/**
* Validate the swagger.  If this is an embedded swagger, then target is the name
* of the target.
*/
function _validate(swagger, target, req) {
    if (target) {
        // If an embedded swagger, then change the refrences to look like root references.
        swagger = u.deepClone(swagger);
        u.replaceRefs(swagger,
          [ { source: '#/x-ibm-configuration/targets/' + target + '/',
              target: '#/' } ]);
    }
    let def = q.defer();
    let errorText = '';
    oasvalidator.validate(swagger, { laxurls: true, warnOnly: true }, function(err, options) {
        if (err) {
            // Ignore this dumb error.  In sume cass maximum and minimum can be large floats, etc.
            if (err.message.indexOf('be a number') < 0) {
                errorText = err + '\n';
            }
        }
        if (options && options.warnings) {
            for (let i = 0; i < options.warnings.length; i++) {
                errorText += g.http(u.r(req)).f('Warning: %s', options.warnings[i]) + '\n';
            }
        }
        if (errorText.length > 0) {
            def.reject(new Error(errorText));
        } else {
            def.resolve();
        }
    });
    return def.promise;
}

/**
* Utility to remove Empty Namespaces
*/
function changeNamespaces(swagger) {
    return u.traverseSchemaObjects(swagger, function(xso) {
        if (xso.xml) {
            if ('namespace' in xso.xml) {
                if (xso.xml.prefix && xso.xml.prefix.length > 0) {
                    // Provide a valid fake url
                    xso.xml.namespace = 'http://temp.com/' + xso.xml.prefix;
                } else {
                    // Remove the namespace to avoid issues
                    delete xso.xml.namespace;
                }
            }
        }
        return xso;
    });
}

exports.getOpenApiV3 = getOpenApiV3;
exports.isOpenApiV3Available = isOpenApiV3Available;
exports.validate = validate;
