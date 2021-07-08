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
// Node module: apiconnect-wsdl

'use strict';

/**
 * Exposed functions for apiconnect-wsdl
 **/
const u = require('../lib/utils.js');
const parse = require('../lib/parse.js');
const generate = require('../lib/generateSwagger.js');
const validate = require('../lib/validate.js');
const updateSwagger = require('../lib/updateSwagger.js');
const genDefs = require('../lib/generateDefs.js');
const extraXSD = require('../lib/extraXSD.js');
const updateWSDL = require('../lib/updateWSDL.js');
const obfuscate = require('../lib/obfuscate.js');
const flatten = require('../lib/flatten.js');

const rest = require('../lib/createRESTfromSOAP.js');
const api = require('../lib/api.js');
const v3 = require('../lib/openApiV3.js');

// ---
// Primary apis: validate, introspect, create, add, inject
// ---

// Validate WSDL/XSD to ensure it is correct
exports.validateWSDL = api.validateWSDL;
exports.validateXSD = api.validateXSD;

// Introspect WSDL to get the services
exports.introspectWSDL = api.introspectWSDL;

// Create an Open API from a wsdl for a particular services
exports.createOpenApi = api.createOpenApi;

// Create and and a target Open Api
exports.addTargetOpenApi = api.addTargetOpenApi;

// Add more definitions to the target
exports.addXSDToTargetOpenApi = api.addXSDToTargetOpenApi;

// Inject Service Endpoints into a wsdl (for a published api)
exports.injectServiceEndpointsIntoWSDLorZIP = updateWSDL.injectServiceEndpointsIntoWSDLorZIP;

// Inline schema includes/imports
exports.inline = flatten.inline;

// Default is to use English only if request is not passed to the api.
// Set to true if the Operating System language should be used.
exports.DEFAULT_GLOBALIZE_USE_OS = false;

// --
// Legacy apis
// --

// Normal flow is for the toolkit/UI to invoke getJsonForWSDL, which returns
// an allWSDLs construct containing the parsed wsdl and xsd files.
exports.getJsonForWSDL = parse.getJsonForWSDL;

// The getWSDServices file is then invoked to get an object containing the names
// of the services, ports, operations
exports.getWSDLServices = parse.getWSDLServices;

// Next the findWSDLForServiceName is invoked with allWSDLs and a serviceName, which
// returns a WSDLEntry containing the wsdl and xsd information for that service.
exports.findWSDLForServiceName = parse.findWSDLForServiceName;

// Then getSwaggerForService is invoked which produces the OpenAPI (Swagger) api
// for the service.  (used in V5)
exports.getSwaggerForService = generate.getSwaggerForService;

// The updateSwagger endpoints are called to update a previously created 'draft' api
// with a new api (or api from wsdl).
exports.updateSwaggerFromWSDL = updateSwagger.updateSwaggerFromWSDL;
exports.updateOpenApiFromWSDL = updateSwagger.updateOpenApiFromWSDL;

exports.updateOpenApi = updateSwagger.updateOpenApi;

exports.getDefinitionsForXSD = extraXSD.getDefinitionsForXSD;

// The setServiceEndpoint updates the wsdl on the server with the address
// information for a published api.
exports.setServiceEndpoint = updateWSDL.setServiceEndpoint;


// --
// Misc apis
// --

// Migrate a V5 openapi to the V6 SOAP-PROXY or SOAP-REST format
exports.migrateFromV5 = rest.migrateFromV5;
exports.migrateToV5 = rest.migrateToV5;


// Convert from Open API V2 to Open API V3
exports.getOpenApiV3 = v3.getOpenApiV3;
exports.isOpenApiV3Available = v3.isOpenApiV3Available;

exports.getNamespaces = validate.getNamespaces;
exports.setAsserts = u.setAsserts;
exports.getVersion = u.getVersion;
exports.sniffSwagger = validate.sniffSwagger;

// Obfuscate wsdl
exports.obfuscate = obfuscate.obfuscate;
exports.deobfuscate = obfuscate.deobfuscate;
exports.deobfuscateAPI = obfuscate.deobfuscateAPI;


// --
// Deprecated apis
// --
exports.generateSwaggerForWsdlProxy = generate.generateSwaggerForWsdlProxy;
