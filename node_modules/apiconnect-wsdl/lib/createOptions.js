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
const R = require('../lib/report.js');

const g = require('../lib/strong-globalize-fake.js');

var NEVER = 'NEVER';
var IFNOTDEFAULT = 'IF-NOT-DEFAULT';
var IFENABLED = 'IF-ENABLED';
var ALWAYS = 'ALWAYS';

var OPTIONS = {
    type: {
        default: 'wsdl',
        allowed: [ 'wsdl', 'wsdl-to-rest' ],
        description: 'The type of api, either \'wsdl\' or \'wsdl-to-rest\'',
        persist: NEVER, // Don't need to persist because information is persisted in wsdl-definition
    },
    openapiVersion: {
        default: '2.0',
        allowed: [ '2.0', '3.0', 'V2', 'V3', 2.0, 2, 3.0, '3.0.0', 2, 3 ],
        description: 'The open api version, either \'2.0\' or \'3.0\'',
        persist: NEVER, // Don't need to persist because information is in the api
    },
    optDefault: {
        default: false,
        allowed: [ true, false ],
        description: 'The default for v3 options',
        persist: IFNOTDEFAULT,
    },
    v3oneOf: {
        default: 'default',
        description: 'Use oneOf in output yaml (for choice and substitutionGroup mappings)',
        persist: IFENABLED,
    },
    v3anyOf: {
        default: 'default',
        description: 'Use oneOf in output yaml (for union mapping)',
        persist: IFENABLED,
    },
    v3nullable: {
        default: 'default',
        description: 'Use nullable (for x-nullable mapping)',
        persist: IFENABLED,
    },
    v3discriminator: {
        default: 'default',
        description: 'Use discriminator (for polymorphism)',
        persist: IFENABLED,
    },
    gateway: {
        default: 'datapower-gateway',
        allowed: [ 'datapower-gateway', 'datapower-api-gateway', 'micro-gateway' ],
        description: 'The target gateway',
        persist: NEVER // Don't need to persist because information is in the api
    },
    sanitizeWSDL: {
        default: false,
        allowed: [ true, false ],
        description: 'Remove WSDL and XSD comments, documentation and unnecessary extensions.',
        persist: IFENABLED
    },
    defaults: {
        default: undefined,
        description: 'Overrides to that are patched onto the created api',
        persist: NEVER,        // Used to merge values into the generated swagger
    },
    req: {
        default: undefined,
        description: 'The language information for the request or operating system',
        persist: NEVER,   // This is the i18n language information
    },
    limits: {
        default: { maxOperations: 500, maxIntermediateKeys: 100000, maxFinalKeys: 500000 },
        description: 'Limits on the size of the generated api',
        persist: IFNOTDEFAULT
    },
    level: {
        default: 'INFO',
        allowed: [ 'DETAIL', 'INFO', 'WARNING', 'ERROR' ],
        description: 'message level',
        persist: IFNOTDEFAULT,
    },
    analysis: {
        default: false,
        allowed: [ true, false ],
        description: 'Post api creation analysis. Consider setting level to DETAIL.',
        persist: IFNOTDEFAULT,
    },
    config: {
        default: undefined,
        description: 'Create options that were injected via a configuration file',
        persist: IFNOTDEFAULT,  // This is config file (possibly injected in the zip)
    },
    port: {
        default: undefined,
        description: 'The name of the port within the service that should be used to generate the api',
        persist: IFNOTDEFAULT,
    },
    wssecurity: {
        default: true,
        allowed: [ true, false ],
        description: 'Should wssecurity definitions be included within the api',
        persist: IFNOTDEFAULT,
    },
    flatten: {
        default: false,
        allowed: [ true, false, 'disable' ],
        description: 'Inline schema imports and includes within input wsdl file(s)',
        persist: IFNOTDEFAULT,
    },
    generateAll: {
        default: false,
        allowed: [ true, false ],
        description: 'Generate all schema definitions',
        persist: IFNOTDEFAULT,
    },
    inlineAttributes: {
        default: true,
        allowed: [ true, false ],
        description: 'Should root attributes be inlined instead of referenced',
        persist: IFNOTDEFAULT,   // development option, currently hidden
    },
    suppressExamples: {
        default: false,
        allowed: [ true, false ],
        description: 'Should auto generated examples be suppressed',
        persist: IFNOTDEFAULT
    },
    allowExtraFiles: {
        default: false,
        allowed: [ true, false ],
        description: 'Should files other than wsdl, xsd, and configuration files be allowed in the input zip',
        persist: NEVER,  // Only used during parsing
    },
    selfContained: {
        default: true,
        allowed: [ true, false ],
        description: 'Should all files be contained within the input, or should the generator look for them on the file system or using remote urls.',
        persist: NEVER,  // Only used during parsing
    },
    strictValidation: {
        default: false,
        allowed: [ true, false ],
        description: 'Should unreferenced schemas in a zip file be validated for correctness.',
        persist: NEVER,  // Only used during parsing
    },
    jsonStyle: {
        default: 'condensed',  // Will change to 'condensed' in FP9
        allowed: [ 'badgerfish', 'condensed' ],
        description: 'What style to use when creating apis for \'wsdl-to-rest\'',
        persist: IFNOTDEFAULT,
    },
    getMethods: {
        default: true,
        allowed: [ true, false ],
        description: 'Add GET methods if input has 5 or fewer scalar variables',
        persist: IFNOTDEFAULT
    },
    // Set automatically if no WSDLs are found in the input
    apiFromXSD: {
        default: undefined,
        description: 'Create API from XSD',
        persist: IFNOTDEFAULT,
    },
    mapSOAPFaults: {
        default: true,
        allowed: [ true, false ],
        description: 'Create a catch for soap faults within the \'wsdl-to-rest\' api',
        persist: IFNOTDEFAULT, // used for wsdl-to-rest
    },
    mapOptions: {
        default: { includeEmptyXMLElements: false, inlineNamespaces: false, mapEnablePostProcessingJSON: true, mapResolveXMLInputDataType: true, mapResolveApicVariables: false },
        description: 'For \'wsdl-to-rest\' api, these are the settings for the assembly map options.  The default is \`{ includeEmptyXMLElements: false, inlineNamespaces: false, mapEnablePostProcessingJSON: true, mapResolveXMLInputDataType: true, mapResolveApicVariables: false }\'',
        persist: IFNOTDEFAULT,
    },
    validatePolicy: {
        default: false,
        allowed: [ true, false ],
        description: 'For \'wsdl-to-rest\' api, auto-generate a validate policy for the request and response.',
        persist: IFNOTDEFAULT,
    },
    testPaths: {
        default: false,
        allowed: [ true, false ],
        description: 'Development Only: Adds extra paths for testing purposes.  Requires wsdl-to-rest.',
        persist: IFNOTDEFAULT,
    },
    implicitHeaderFiles: {
        default: undefined,
        decription: 'Array of xsd file names that should be processed as implicit headers.',
        persist: IFNOTDEFAULT
    },
    fromGetDefinitionsForXSD: {
        default: false,
        allowed: [ true, false ],
        description: 'Development Only: Indicates if process xsd input (versus wsdl input)',
        persist: NEVER,      // Used only for extra xsd schemas
    },
    rootElementList: {
        default: undefined,
        description: 'Development Only: Elements to consider if fromGetDefinitionsForXSD is set',
        persist: NEVER       // hidden, development option used with formGetDefinitionsForXSD
    }
};

var DEFAULTS = _getDefaults();

/**
* create
* Creates a createOptions struct
* @param _options (createOptions struct passed in via an api)
* @param _defaults (optinal context defaults)
* @return createOptions struct with all defaults applied and validated
*
*/
function create(_options, _defaults) {
    _options = _options || {};
    _defaults = _defaults || {};
    let options = _.merge({}, DEFAULTS, _defaults, _options);
    for (let key in options) {
        if (options[key] === 'default') {
            options[key] = options['optDefault'];
        }
    }
    if (!options.req) {
        if (u.r(options.req)) {
            options.req = u.deepClone(u.r(options.req));
        } else {
            options.req = {};
        }
    }
    if (options.v3discriminator) {
        options.v3oneOf = true;  // discriminator requires oneOf
    }
    return validate(options);
}

/**
* Validates the options. Removes unrecognized properties.
* @param options
* @return clone of options
*/
function validate(options) {
    options = u.deepClone(options);
    let req = options.req;
    let expectedKeys = Object.keys(DEFAULTS);
    for (let key in options) {
        if (expectedKeys.indexOf(key) < 0) {
            delete options[key];
            R.error(req, g.http(u.r(req)).f('Unexpected option found %s.', key));
        } else {
            if (OPTIONS[key].allowed) {
                if (OPTIONS[key].allowed.indexOf(options[key]) < 0) {
                    throw new Error(g.http(u.r(req)).f('Expected %s to have a value in %s, but found %s.', key, OPTIONS[key].allowed, options[key]));
                }
            }
        }
    }
    // Set openapiVersion to the canonical value
    if (options.openapiVersion === '3.0' ||
       options.openapiVersion === 3 ||
       options.openapiVersion === '3.0.0' ||
       options.openapiVersion === 3.0 ||
       options.openaniVersion === 'V3') {
        options.openapiVersion = '3.0';
    } else {
        options.openapiVersion = '2.0';
    }
    return options;
}

/**
* Persists the option by putting it into the open api
* @param swagger open api
* @param options
*/
function persistOptions(options, swagger) {
    swagger['x-ibm-configuration'] = swagger['x-ibm-configuration'] || {};
    swagger['x-ibm-configuration']['x-ibm-apiconnect-wsdl'] = {
        'package-version': u.getVersion(),
        options: {}
    };
    let o = swagger['x-ibm-configuration']['x-ibm-apiconnect-wsdl'].options;
    for (let key in options) {
        if (OPTIONS[key]) {
            if (OPTIONS[key].persist == NEVER) {
                // Some options are not persisted
            } else if (OPTIONS[key].persist == IFNOTDEFAULT) {
                // To reduce complexity, some options are only persisted if their values are different than the default
                if (!_.isEqual(options[key], OPTIONS[key].default)) {
                    o[key] = options[key];
                }
            } else if (OPTIONS[key].persist == IFENABLED) {
                // Too reduce complexity, some options are only persisted if their values are different than the default
                if (options[key]) {
                    o[key] = options[key];
                }
            } else {
                // Some options are always persisted.
                o[key] = options[key];
            }
        }
    }
}

function _getDefaults() {
    let defaults = {};
    for (let key in OPTIONS) {
        defaults[key] = OPTIONS[key].default;
    }
    return defaults;
}

exports.create = create;
exports.persistOptions = persistOptions;
exports.validate = validate;
