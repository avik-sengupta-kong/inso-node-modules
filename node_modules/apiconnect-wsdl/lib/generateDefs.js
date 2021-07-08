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
* Utility functions to generate SwaggerDefinition the apiconnect-wsdl parser
**/
const u = require('../lib/utils.js');
const dictionary = require('../lib/dictionary.js');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');
const R = require('../lib/report.js');


const assert = require('assert');
const util = require('util');
var _ = require('lodash');

// Context of referencing element or attribute
var UNQUALNS = 'UNQUALIFIED_NAME_SPACE';

// Child descriptions place on parent or on Child
var CHILD_DESCRIPTION_PLACED_ON_PARENT = false;

/**
*  The dictionary contains the node.soap schema for each ns name.
*  For example, dict.dictEntry['foo_ns1'].schema is the schema for the foo element or type
*  in ns1.
*
*  An ns name is referenced by other types and elements.  The referencing context
*  determines the namespace qualification (or no namespace qualification..aka unqualified) of
*  the referencing type.  (And the defining context defines the namespace qualification of the inner types, extensions, etc).
*  Thus if foo_ns1 is referenced in a qualified schema, ns2, then the code needs to generate a
*  swagger definition unique for that context  (foo_ns1_ns2).  Or if foo_ns1 is referenced in an unqualified schema,
*  then the code needs to generate a foo_ns1_unqual definition.  (Note that there are some optimizations to
*  help reduce the number of definitions...thus we might generate foo_ns1 instead of foo_ns_unqual).
*
*  Summary: The swagger definition is the product of a (nsName, referencingContext).
*/

/**
* Add a reference to the reference map.
* The dictionary item being referenced is nsName and the referencingContext is the information about the reference
* @param refMap is the reference map
* @param nsName is target name
* @param referencingContext
*/
function addReference(refMap, nsName, referencingContext) {
    referencingContext = u.deepClone(referencingContext);
    if (!refMap[nsName]) {
        refMap[nsName] = {
            offset: 0,
            referencingContexts: [ referencingContext ]
        };
    } else {
        // Add the referencing context if not found
        let found = false;
        let len = refMap[nsName].referencingContexts.length;
        for (let i = 0; i < len; i++) {
            if (referencingContext.ns == refMap[nsName].referencingContexts[i].ns &&
                referencingContext.xmlName == refMap[nsName].referencingContexts[i].xmlName &&
                referencingContext.attribute == refMap[nsName].referencingContexts[i].attribute) {
                found = true;
                break;
            }
        }
        if (!found) {
            refMap[nsName].referencingContexts.push(referencingContext);
        }
    }
}

/**
* @return the definition name for a (nsName + referencingContext)
*/
function getDefinitionName(nsName, referencingContext, namespaces) {
    let definitionName = nsName;
    let contextSuffix = '';

    if (referencingContext && referencingContext.attribute) {
        contextSuffix += '_attr';
    }
    if (referencingContext && referencingContext.ns) {
        if (referencingContext.ns == UNQUALNS) {
            contextSuffix += '_unqual';
        } else {
            contextSuffix += '_' + u.getPrefixForNamespace(referencingContext.ns, namespaces);
        }
    }

    if (referencingContext && referencingContext.xmlName) {
        contextSuffix += '_of_' + referencingContext.xmlName;
    }

    definitionName = (contextSuffix == '') ? definitionName : definitionName + contextSuffix;

    return definitionName;
}

/*
* Create the Swagger Definitions for the references in refMap.
*/
function generateSwaggerDefinitions(definitions, refMap, dict, namespaces, oldRefMap, totalRefMap) {

    // Create a clone of the refMap.
    // New references will be added to the cloned refMap by the generateSwaggerDefinition function
    let cloneRefMap = u.extendObject({}, refMap);

    // Compare the refMap to the old refMap and create a list
    // of the name value pairs that need to be processed.
    oldRefMap = oldRefMap || {};
    let refList = u.disjointKeysToArray(refMap, oldRefMap);

    let len = refList.length;
    for (var i = 0; i < len; i++) {
        // The refList has a name (which is the nsName)
        // and a value (which is the referencingContext array and an offset)
        // The offset indicates which referencingContexts have already been processed.
        // For example name (foo_ns) might have 1 referencingContext, but additional
        // referencingContexts are discovered during this recursive generation code.
        // The offset is the indicator of which referencingContexts have been processed
        // and which have not.
        let nameValue = refList[i];
        let nsName = nameValue.name;
        let value = nameValue.value;

        let rcLen = value.referencingContexts.length;
        for (var j = value.offset; j < rcLen; j++) {
            addReference(totalRefMap, nsName, value.referencingContexts[j]);
            generateRootDefinition(nsName, value.referencingContexts[j], definitions, cloneRefMap, dict, namespaces);
        } // end for
        // track how far we are through the array
        refMap[nsName].offset = rcLen;
    }

    // Find the newly added references and generate those swagger definitions.
    if (len > 0) {
        generateSwaggerDefinitions(definitions, cloneRefMap, dict, namespaces, refMap, totalRefMap);
    }
}

/**
* Create a Root Definitions for the nsName + referencingContext
*/
function generateRootDefinition(nsName, referencingContext, definitions, refMap, dict, namespaces) {
    var rootXSO;
    var definitionName;
    var updated = false;

    let dictEntry = dict.dictEntry[nsName];

    if (dictEntry) {

        // Create the definition name from the nsName and the referencingContext information
        definitionName = getDefinitionName(nsName, referencingContext, namespaces);

        // Create the rootXSO
        if (!definitions[definitionName]) {
            let referencingContextForXML = u.deepClone(referencingContext);

            if (!referencingContextForXML.ns) {
                // If the name is used as an element, then set the reference to the namespace of the element.
                // otherwise set it to the tns if qualified or UNQUAL if not qualified
                if (dictEntry.tagInfo && dictEntry.tagInfo.xml) {
                    referencingContextForXML.ns = dictEntry.tagInfo.xml.ns;
                } else {
                    referencingContextForXML.ns = dictEntry.qualified ? dictEntry.tns : UNQUALNS;
                }
            }
            rootXSO = generateSwaggerXSO(dictEntry, dict, refMap, namespaces, referencingContextForXML);
            definitions[definitionName] = rootXSO;
            updated = true;
        }
    }

    if (!updated) {
        return;
    }

    // Extra Information is added to the root xso depending on the kind of schema contruct.
    // For example, xsi-type information and polymorphism information is added.

    // Add xmlname and attribute information to the xso.xml
    if (rootXSO.xml) {
        if (referencingContext && referencingContext.xmlName) {
            rootXSO.xml.name = referencingContext.xmlName;
        }
        if (referencingContext && referencingContext.attribute) {
            rootXSO.xml.attribute = true;
        }
    }
    if (dictEntry.schemaType === 'typeOf' && dictEntry.typeNSName) {
        addReference(refMap, dictEntry.typeNSName, {});
    }

    if (!dictEntry.schema || !dictEntry.for) {
        // predefined or soap or unknown constructs
        return;
    }
    if (dictEntry.for === 'typedef') {
        if (dictEntry.tagInfo) {
            if (dictEntry.tagInfo) {
                rootXSO['x-xsi-type'] = dictEntry.tagInfo.name;
            }
        }
        if (rootXSO['x-xsi-type']) {
            if (dict.dictEntry[nsName].subTypes) {
                // If the original type is base_ns1, and this is a derivative (base_ns1_unqual), then
                // it also needs the discriminator.
                rootXSO['x-ibm-discriminator'] = true;
            }

            if (dictEntry.tagInfo && dictEntry.tagInfo.abstract) {
                rootXSO['x-xsi-type-abstract'] = true;
            }

            // In addition, also set the x-xsi-type-xml object from the location of the original type
            if (dictEntry.tns) {
                rootXSO['x-xsi-type-xml'] = {
                    namespace: dictEntry.tns
                };
                rootXSO['x-xsi-type-xml'].prefix = u.getPrefixForNamespace(dictEntry.tns, namespaces);
                if (!dict.createOptions.v3discriminator) {
                    // only need unique name if not using v3 discriminator
                    rootXSO['x-xsi-type-uniquename'] =  definitionName;
                }
            }
        }
    } else if (dictEntry.for === 'type') {
        // For Open API Version 2.0 polymorphism format, each TYPE ref has a unique hierarchy tree.
        // For Open API Version 3.0 (discriminator), there is a common TYPEDEF hierarchy.
        let dDictEntry = dict.dictEntry[dictEntry.typeNSName];
        let inPolyTree = dDictEntry &&
              (dDictEntry.ancType || dDictEntry.subTypes);
        // Add the ancestor and subTypes references
        if (inPolyTree) {
            if (dDictEntry.ancType) {
                if (dict.createOptions.v3discriminator) {
                    rootXSO['x-anc-ref'] = {
                        $ref: '#/definitions/' + dDictEntry.ancType
                    };
                    addReference(refMap, dDictEntry.ancType, {});
                } else {
                    let rc = {
                        ns: referencingContext.ns
                    };
                    let ancDictEntry = dict.dictEntry[dDictEntry.ancType];
                    let ancNSName = ancDictEntry.refNSName;
                    addReference(refMap, ancNSName, rc);
                    rootXSO['x-anc-ref'] = {
                        $ref: '#/definitions/' + getDefinitionName(ancNSName, rc, namespaces)
                    };
                }
            }
            if (dDictEntry.subTypes) {
                if (dict.createOptions.v3discriminator) {
                    rootXSO['x-desc-ref'] = [];
                    for (let i = 0; i < dDictEntry.allDescendents.length; i++) {
                        rootXSO['x-desc-ref'].push({
                            $ref: '#/definitions/' + dDictEntry.allDescendents[i]
                        });
                        addReference(refMap, dDictEntry.allDescendents[i], {});
                    }
                } else {
                    rootXSO['x-desc-ref'] = [];
                    for (let i = 0; i < dDictEntry.subTypes.length; i++) {
                        let rc = {
                            ns: referencingContext.ns
                        };
                        let descDictEntry = dict.dictEntry[dDictEntry.subTypes[i]];
                        let descNSName = descDictEntry.refNSName;
                        addReference(refMap, descNSName, rc);
                        rootXSO['x-desc-ref'].push({
                            $ref: '#/definitions/' + getDefinitionName(descNSName, rc, namespaces)
                        });
                    }
                }
            }
        }
    }
    return;
}

// Generate a Open API (Swagger) XML Schema Object (aka XSO)
// An XML Schema Object is defined by Open API as the represntation of an XML construct.
// Each definition in the definitions section is an XML Schema Object.
// And definitions may have embedded, inlined XMLSchma Object.
// The generateSwaggerXSO is the common code for all XSO generation
function generateSwaggerXSO(dictEntry, dict, refMap, namespaces, referencingContextForXML) {
    let req = dict.req;
    dictionary.complexityLimitCheck(dict);
    if (dictEntry.schemaType == 'predefined') {
        handleAnnotationRef(dictEntry.schema, dictEntry.definition, req);
        return dictEntry.definition;
    } else if (dictEntry.schemaType == 'anyType') {
        let xso = {};
        setXSOxml(xso, referencingContextForXML, namespaces, dictEntry.tns, dictEntry.for === 'attribute');

        handleAnnotationRef(dictEntry.schema, xso, req);
        return xso; // An anyType will have no type
    } else if (dictEntry.schemaType == 'typeOf') {
        // Create an element or type that is just a typeOf another type.
        // the post-generation processing will finish the creation of the xso (and any polymorphic trees).
        let xso = {};
        setXSOxml(xso, referencingContextForXML, namespaces, dictEntry.tns, dictEntry.for === 'attribute');
        xso.typeOf = {
            $ref: '#/definitions/' + dictEntry.typeNSName
        };
        addReference(refMap, dictEntry.typeNSName, {});
        if (!dict.dictEntry[dictEntry.typeNSName]) {
            dictionary.annotateError(dictEntry.schema,
               g.http(u.r(req)).f('A root \'element\' uses the \'type\' or \'substitutionGroup\' attribute to reference a definition that could not be found, %s. ' +
               'Processing continues without the definition.', dictEntry.typeNSName));
            delete xso.typeOf;
            xso.type = 'string';
        }

        handleAnnotationRef(dictEntry.schema, xso, req);
        return xso;
    } else {
        let xso;
        if (dictEntry.schemaType == 'simple') {
            xso = generateSwaggerXSO_forSimpleType(dictEntry, dict, refMap, namespaces, referencingContextForXML);
        } else if (dictEntry.schemaType == 'complex') {
            xso = generateSwaggerXSO_forComplexType(dictEntry, dict, refMap, namespaces, referencingContextForXML);
        } else if (dictEntry.for == 'attributeGroup') {
            xso = generateSwaggerXSO_forAttributeGroup(dictEntry, dict, refMap, namespaces, referencingContextForXML);
        } else if (dictEntry.for == 'group') {
            xso = generateSwaggerXSO_forGroup(dictEntry, dict, refMap, namespaces, referencingContextForXML);
        } else if (dictEntry.for == 'substitutionGroup') {
            xso = generateSwaggerXSO_forSubstitutionGroup(dictEntry, dict, refMap, namespaces, referencingContextForXML);
        }
        xso = u.squashAllOf(xso);
        return xso;
    }
}

/**
* Set the xml object on the xso using the referencing context
*/
function setXSOxml(xso, referencingContext, namespaces, tns, isAttribute) {
    xso.xml = {};
    if (referencingContext && referencingContext.ns) {
        if (referencingContext.ns == UNQUALNS) {
            xso.xml.namespace = '';
            xso.xml.prefix = '';
        } else {
            xso.xml.namespace = referencingContext.ns;
            xso.xml.prefix = u.getPrefixForNamespace(referencingContext.ns, namespaces);
        }
    } else {
        xso.xml.namespace = tns;
        xso.xml.prefix = u.getPrefixForNamespace(tns, namespaces);
    }
    if (isAttribute) {
        xso.xml.attribute = isAttribute;
    }
}

// Generate a Open API (Swagger) XML Schema Object (aka XSO) for a simpleType
function generateSwaggerXSO_forSimpleType(dictEntry, dict, refMap, namespaces, referencingContextForXML) {
    let req = dict.req;
    let xso = {};
    setXSOxml(xso, referencingContextForXML, namespaces, dictEntry.tns, dictEntry.for === 'attribute');

    // schema will contain a restriction, list or union
    if ('list' in dictEntry.schema) {
        // xsd:list is a whitespace delimited string of the types defined in the itemType attribute.
        // This is an uncommon usage, and the best approach is to map to a string
        xso.type = 'string';
    } else if (dictEntry.schema.restriction) {
        processSchemaSimpleRestriction(dictEntry.schema.restriction, xso, dict, dictEntry, refMap, namespaces);
    } else if ('union' in dictEntry.schema) {
        handleUnionRef(dictEntry.schema.union, dictEntry, dict, refMap, xso, namespaces, dictEntry.tns);
    }

    // Convert the annotations after processing the other elements because that processing may add additional annotations.
    handleAnnotationRef(dictEntry.schema, xso, req);
    return xso;
}

function handleUnionRef(union, dictEntry, dict, refMap, xso, namespaces, tns) {
    let req = dict.req;
    xso.anyOf = [];

    if (union.simpleType) {
        union.simpleType = u.makeSureItsAnArray(union.simpleType);
        for (let i = 0; i < union.simpleType.length; i++) {
            let simpleSchema = {
                tns: tns,
                schemaType: 'simple',
                schema: union.simpleType[i],
                xmlns: dictEntry.xmlns,
                qualified: dictEntry.qualified,
                qualifiedAttr: dictEntry.qualifiedAttr
            };
            var simpleXSO = generateSwaggerXSO(simpleSchema, dict, refMap, namespaces, {});
            xso.anyOf.push(simpleXSO);
        }
    }
    if (union['undefined'] && union['undefined'].memberTypes) {
        let memberTypes = _.split(union['undefined'].memberTypes, ' ');
        for (let i = 0; i < memberTypes.length; i++) {
            let nsName = dictionary.bestMatch(memberTypes[i], 'typedef', dictEntry, dict, namespaces);
            let isXSD = dictionary.isXSDType(memberTypes[i], namespaces, dictEntry.xmlns);
            if (dict.dictEntry[nsName]) {
                let refNSName = getDefinitionName(nsName, {}, namespaces);
                addReference(refMap, nsName, {});
                xso.anyOf.push({
                    $ref: '#/definitions/' + refNSName
                });
            } else if (isXSD) {
                let xsdXSO = mapXSDTypeToSwagger(u.stripNamespace(memberTypes[i]), dict);
                xso.anyOf.push(xsdXSO);
            } else {
                dictionary.annotateError(dictEntry.schema,
                  g.http(u.r(req)).f('The \'memberType\' %s of the \'union\' element cannot be found.', memberTypes[i]));
            }
        }
    }
    return xso;
}


// Generate a Open API (Swagger) XML Schema Object (aka XSO) for a complexType
function generateSwaggerXSO_forComplexType(dictEntry, dict, refMap, namespaces, referencingContextForXML) {
    let req = dict.req;
    var xso = {};
    setXSOxml(xso, referencingContextForXML, namespaces, dictEntry.tns);

    if (dictEntry.schema.complexContent) {
        handleComplexContentRef(dictEntry.schema.complexContent, dictEntry, dict, refMap, xso,
          namespaces, dictEntry.tns);
        handleAnnotationRef(dictEntry.schema, xso, req);
        return xso;
    } else if (dictEntry.schema.simpleContent) {
        handleSimpleContentRef(dictEntry.schema.simpleContent, dictEntry, dict, refMap, xso,
          namespaces, dictEntry.tns);
        handleAnnotationRef(dictEntry.schema, xso, req);
        return xso;
    }

    // The construct mixed=true is not supported for the general case,
    // but if there are no elements in the complexType, then we map the mixed content to a string.
    var mixedContentMappedToString = false;
    if (dictEntry.schemaType === 'complex' && dictEntry.schema['undefined'] && dictEntry.schema['undefined'].mixed === 'true') {
        if (dictEntry.schema.sequence ||
            dictEntry.schema.all ||
            dictEntry.schema.choice ||
            dictEntry.schema.group) {
            // Allow sequence with just an any element
            if (dictEntry.schema.sequence) {
                let s = dictEntry.schema.sequence;
                if (s.any &&
                    !(s.element || s.group || s.sequence || s.all || s.choice || s.list)) {
                    mixedContentMappedToString = true;
                }
            }
        } else {
            mixedContentMappedToString = true;
        }
        if (!mixedContentMappedToString) {
            dictionary.annotateWarning(dictEntry.schema, g.http(u.r(req)).f('The \'mixed=true\' attribute is ignored.'));
        }
    }

    // Only a single sequence, group, all or choice reference is allowed.
    detectMultipleSGAC(dictEntry.schema, dictEntry, req);

    xso.allOf = [ {
        xml: u.deepClone(xso.xml),
        type: 'object',
        properties: {}
    } ];
    handleSGACRef(dictEntry.schema, dictEntry, dict, refMap, xso.allOf, namespaces, dictEntry.tns);

    if (dictEntry.schema.anyAttribute) {
        // Ignore
    }
    // attributes can appear in addition to other entries
    if (dictEntry.schema.attribute) {
        handleAttributeRef(dictEntry.schema.attribute, dictEntry, dict, refMap, xso.allOf, namespaces, dictEntry.tns);
    }
    if (dictEntry.schema.attributeGroup) {
        handleAttributeGroupRef(dictEntry.schema.attributeGroup, dictEntry, dict, refMap, xso.allOf, namespaces, dictEntry.tns);
    }

    if (mixedContentMappedToString) {
        // Put the attributes in an allOf and then add a string for the mixed content
        xso = {
            xml: u.deepClone(xso.xml),
            allOf: [
                u.deepClone(xso),
                {
                    xml: u.deepClone(xso.xml),
                    type: 'string'
                }
            ]
        };
    }
    handleAnnotationRef(dictEntry.schema, xso, req);

    // Remove unnecessary property object
    if (xso.properties && _.isEmpty(xso.properties) && xso.type && xso.type !== 'object') {
        delete xso.properties;
    }
    return xso;
}

// Generate a Open API (Swagger) XML Schema Object (aka XSO) for an attributeGroup
function generateSwaggerXSO_forAttributeGroup(dictEntry, dict, refMap, namespaces, referencingContextForXML) {
    let req = dict.req;
    let xso = {};
    setXSOxml(xso, referencingContextForXML, namespaces, dictEntry.tns);
    xso.allOf = [ {
        xml: u.deepClone(xso.xml),
        type: 'object',
        properties: {}
    } ];

    if (dictEntry.schema.anyAttribute) {
        // Ignore
    }
    if (dictEntry.schema.attribute) {
        handleAttributeRef(dictEntry.schema.attribute, dictEntry, dict, refMap, xso.allOf, namespaces, dictEntry.tns);
    }
    if (dictEntry.schema.attributeGroup) {
        handleAttributeGroupRef(dictEntry.schema.attributeGroup, dictEntry, dict, refMap, xso.allOf, namespaces, dictEntry.tns);
    }

    // Convert the annotations after processing the other elements because that processing may add additional annotations.
    handleAnnotationRef(dictEntry.schema, xso, req);
    return xso;
}

// Generate a Open API (Swagger) XML Schema Object (aka XSO) for a group
function generateSwaggerXSO_forGroup(dictEntry, dict, refMap, namespaces, referencingContextForXML) {
    let req = dict.req;
    let xso = {};
    setXSOxml(xso, referencingContextForXML, namespaces, dictEntry.tns);
    xso.allOf = [ {
        xml: u.deepClone(xso.xml),
        type: 'object',
        properties: {}
    } ];

    handleGroupContent(dictEntry.schema, dictEntry, dict, refMap, xso.allOf, namespaces, dictEntry.tns);

    // Convert the annotations after processing the other elements because that processing may add additional annotations.
    handleAnnotationRef(dictEntry.schema, xso, req);
    return xso;
}

// Generate a Open API (Swagger) XML Schema Object (aka XSO) for a substitutionGroup
function generateSwaggerXSO_forSubstitutionGroup(dictEntry, dict, refMap, namespaces, referencingContextForXML) {
    let req = dict.req;
    let xso = {};
    setXSOxml(xso, referencingContextForXML, namespaces, dictEntry.tns);
    xso.oneOf = [ {
        xml: u.deepClone(xso.xml),
        type: 'object',
        properties: {},
    } ];
    delete xso.type;
    delete xso.properties;

    // Detect if there are any propertyName collisions
    let used = {};
    let collision = {};
    for (let i = 0; i <= dictEntry.nsNames.length; i++) {
        let elemNSName = dictEntry.nsNames[i];
        let elemDictEntry = dict.dictEntry[elemNSName];
        if (elemDictEntry && !elemDictEntry.tagInfo.abstract) {
            let propName = elemDictEntry.tagInfo.name;
            collision[propName] = used[propName];
            used[propName] = true;
        }
    }

    // Add each element reference to the xso.oneOf
    for (let i = 0; i <= dictEntry.nsNames.length; i++) {
        let elemNSName = dictEntry.nsNames[i];
        let elemDictEntry = dict.dictEntry[elemNSName];
        if (elemDictEntry && !elemDictEntry.tagInfo.abstract) {
            let elemXSO = newXSO(xso.oneOf, true);
            let propName = elemDictEntry.tagInfo.name;
            let referencingContext = {};
            // If propertyCollision, then create an element with an xml name.
            // Except in the following scenario:
            //     .. in schema s1
            //        <xs:element name="Foo" >...
            //     .. in schema s2
            //        <xs:element name="Foo" substitutionGroup="s1:Foo">...
            // in this case, the intent of the second Foo is to 'override' the
            // first one.  So use 's1:Foo' for the first property and use
            // 'Foo' for the second property.
            if (collision[elemDictEntry.tagInfo.name] &&
                (elemDictEntry.tagInfo.name !== dictEntry.tagInfo.name ||  // Normal Case
                (elemDictEntry.tagInfo.name === dictEntry.tagInfo.name &&  // Override Case
                 elemDictEntry.tagInfo.xml && dictEntry.tagInfo.xml &&
                 elemDictEntry.tagInfo.xml.ns === dictEntry.tagInfo.xml.ns))) {
                propName = uniquePropertyName(elemNSName);
                referencingContext.xmlName = elemDictEntry.tagInfo.name;
            }
            addReference(refMap, elemNSName, referencingContext);
            elemXSO.properties[propName] = {
                $ref: '#/definitions/' + getDefinitionName(elemNSName, referencingContext, namespaces)
            };
            if (elemDictEntry.tagInfo.nillable) {
                elemXSO.properties[propName]['x-nullable'] = true;
            }
        }
    }

    // Convert the annotations after processing the other elements because that processing may add additional annotations.
    handleAnnotationRef(dictEntry.schema, xso, req);
    return xso;
}



/**
* Detect multiple sequence, group, all or choice references and issue a message if a violation is found.
*/
function detectMultipleSGAC(schema, dictEntry, req) {
    // Alert if multiple constructs defined
    let countConstructs = 0;
    let constructs = [ 'sequence', 'all', 'choice', 'group' ];
    for (let i = 0; i < constructs.length; i++) {
        let construct = constructs[i];
        if (schema[construct]) {
            countConstructs += Array.isArray(schema[construct]) ? schema[construct].length : 1;
        }
    }
    if (countConstructs > 1) {
        dictionary.annotateWarning(dictEntry.schema, g.http(u.r(req)).f('A \'complexType\' may contain only one \'sequence\', one \'choice\', one \'group\', or one \'all\'. Please correct the schema.'));
    }
}

/**
* Add the annotation documentation to the xso.desciption
*/
function handleAnnotationRef(schema, xso, req) {
    if (schema && schema.annotation) {
        // include annotation as description
        if (schema.annotation.documentation) {
            xso.description = u.cleanupDocumentation(schema.annotation.documentation, req);
        }
        if (schema.annotation.apic) {
            xso['x-ibm-messages'] = schema.annotation.apic;
        }
    }
}

/**
* handle simpleContent reference within the xso
*/
function handleSimpleContentRef(simpleContent, dictEntry, dict, refMap, xso, namespaces, tns) {
    if (simpleContent['undefined'] && simpleContent['undefined'].mixed === 'true') {
        dictionary.annotateWarning(dictEntry.schema, 'The mixed=true attribute on simpleContent is ignored.');
    }
    // look for extension of primitive type
    let extension = dictEntry.schema.simpleContent.extension;
    let restriction = dictEntry.schema.simpleContent.restriction;
    if (extension) {
        delete xso.type;
        delete xso.properties;
        xso.allOf = [ {
            xml: u.deepClone(xso.xml),
            type: 'object',
            properties: {}
        } ];
        let baseType = dictionary.resolveNameInNamespace(extension['undefined'].base, 'typedef', dictEntry.xmlns, namespaces, null, dict);
        if (baseType) {
            if (dict.dictEntry[baseType]) {
                let baseNSName = baseType;
                addReference(refMap, baseType, {});
                newXSO(xso.allOf);
                xso.allOf[0] = { $ref: '#/definitions/' + baseNSName };
            } else {
                var simpleType = mapXSDTypeToSwagger(u.stripNamespace(extension['undefined'].base), dict);
                u.extendObject(lastXSO(xso.allOf), simpleType);
            }
        }
        // attributes can appear on extensions
        if (extension.anyAttribute) {
            // Ignore
        }
        if (extension.attribute) {
            handleAttributeRef(extension.attribute, dictEntry, dict, refMap, xso.allOf, namespaces, dictEntry.tns);
        }
        if (extension.attributeGroup) {
            handleAttributeGroupRef(extension.attributeGroup, dictEntry, dict, refMap, xso.allOf, namespaces, dictEntry.tns);
        }
    } else if (restriction) {
        processSchemaSimpleRestriction(restriction, xso, dict, dictEntry, refMap, namespaces);
    }
    return xso;
}

/**
* handle contentContent reference within the xso
*/
function handleComplexContentRef(complexContent, dictEntry, dict, refMap, xso, namespaces, tns) {
    let req = dict.req;
    if (complexContent['undefined'] && complexContent['undefined'].mixed === 'true') {
        dictionary.annotateWarning(dictEntry.schema, 'The mixed=true attribute on complexContent is ignored.');
    }
    xso.type = 'object';
    xso.properties = {};
    let restriction = complexContent.restriction;
    let extension = complexContent.extension;
    if (restriction) {
        let baseType = u.stripNamespace(restriction['undefined'].base);
        if (baseType) {
            baseType = baseType.toLowerCase();
            if (baseType == 'array') {
                dictionary.annotateError(dictEntry.schema, g.http(u.r(req)).f('A \'restriction\' of a \'soap-enc\' array is not fully supported.  This is a violation of a WS-I Rule (R2110 In a DESCRIPTION, declarations MUST NOT extend or restrict the soapenc:Array type.).'));
                // deal with array types
                let attribute = restriction.attribute;
                if (attribute) {
                    for (var attr in attribute['undefined']) {
                        var attrName = u.stripNamespace(attr).toLowerCase();
                        if (attrName == 'arraytype') {
                            var rawArrayType = attribute['undefined'][attr];
                            if (rawArrayType.indexOf('[]', rawArrayType.length - 2) != -1) {
                                rawArrayType = rawArrayType.substr(0, rawArrayType.length - 2);
                            }
                            var arrayType = dictionary.bestMatch(rawArrayType, 'type', dictEntry.schema, dict, namespaces);
                            xso.type = 'array';
                            delete xso.properties;
                            xso.items = {};
                            if (dict.dictEntry[arrayType]) {
                                // reference is to another type - recurse
                                // only include if we've not already seen it as a parent type
                                addReference(refMap, arrayType, {});
                                xso.items['$ref'] = '#/definitions/' + arrayType;
                            } else {
                                let swaggerType = mapXSDTypeToSwagger(u.stripNamespace(rawArrayType), dict);
                                u.extendObject(xso.items, swaggerType);
                            }
                            break;
                        }
                    } // end for
                }
            } else {
                // Restriction of complexContent is rare
                // Add the elements in the embedded sequence.
                // The base is read, and used to set up the xml information
                let baseType = dictionary.bestMatch(restriction['undefined'].base, 'typedef', dictEntry, dict, namespaces);
                if (!baseType || !dict.dictEntry[baseType] || !dict.dictEntry[baseType].schema) {
                    if (restriction['undefined'].base.indexOf('anyType') < 0) {
                        dictionary.annotateError(dictEntry.schema,
                          g.http(u.r(req)).f('The \'base\' %s of the \'restriction\' element cannot be found.', restriction['undefined'].base));
                    }
                } else {
                    let baseSchema = dict.dictEntry[baseType];
                    let baseNSName = baseType;
                    addReference(refMap, baseType, {});
                    // use an allOf so that we can separate the xml stanza
                    // of the caller from the xml of the restriction base
                    // The x-ibm-complex-restriction flag is used in post
                    // generate to insert the attributes from the base definition
                    delete xso.type;
                    delete xso.properties;
                    xso.allOf = [];
                    xso['x-ibm-complex-restriction'] = baseNSName;

                    xso.allOf.push({
                        $ref: '#/definitions/' + baseNSName
                    });

                    // Create properties for the restricted sequence
                    let xsoContent = {
                        xml: {},
                        type: 'object',
                        properties: {}
                    };
                    xso.allOf.push(xsoContent);

                    // For a restriction, the referencing context is not this schema it is the
                    // the schema of the base type.
                    if (baseSchema.qualified) {
                        xsoContent.xml.namespace = baseSchema.tns;  // Changed to restriction base
                        xsoContent.xml.prefix = u.getPrefixForNamespace(baseSchema.tns, namespaces);
                    } else {
                        xsoContent.xml.namespace = '';
                        xsoContent.xml.prefix = '';
                    }
                    handleSGACRef(restriction, baseSchema, dict, refMap, xso.allOf, namespaces, baseSchema.tns);

                    if (restriction.anyAttribute) {
                        // Ignore
                    }
                    // attributes can appear on restriction
                    if (restriction.attribute) {
                        handleAttributeRef(restriction.attribute, dictEntry, dict, refMap, xso.allOf, namespaces, dictEntry.tns);
                    }
                    if (restriction.attributeGroup) {
                        handleAttributeGroupRef(extension.attributeGroup, dictEntry, dict, refMap, xso.allOf, namespaces, dictEntry.tns);
                    }
                }
            }
        }
    }
    // look for extension of existing type
    if (extension) {
        delete xso.type;
        delete xso.properties;
        xso.allOf = [ {
            xml: u.deepClone(xso.xml),
            type: 'object',
            properties: {}
        } ];
        let baseType = dictionary.bestMatch(extension['undefined'].base, 'typedef', dictEntry, dict, namespaces);
        if (baseType) {
            if (dict.dictEntry[baseType]) {
                // Adjust the name per the referencingContext
                // Example, if we are generating Ext_S1_unqual then the baseType will
                // be something like Base_S1_unqual
                let baseNSName = baseType;
                addReference(refMap, baseType, {});
                newXSO(xso.allOf);
                xso.allOf[0] = { $ref: '#/definitions/' + baseNSName };
                if (isSGAC(extension)) {
                    handleSGACRef(extension, dictEntry, dict, refMap, xso.allOf, namespaces, dictEntry.tns);
                }
            }
        }
        // attributes can appear on extensions
        if (extension.anyAttribute) {
            // ignore
        }
        if (extension.attribute) {
            handleAttributeRef(extension.attribute, dictEntry, dict, refMap, xso.allOf, namespaces, dictEntry.tns);
        }
        if (extension.attributeGroup) {
            handleAttributeGroupRef(extension.attributeGroup, dictEntry, dict, refMap, xso.allOf, namespaces, dictEntry.tns);
        }
    }
}


/**
* Process restriction containedWithin simpleType or simpleContent
*/
function processSchemaSimpleRestriction(restriction, inXSO, dict, dictEntry, refMap, namespaces) {
    delete inXSO.type;
    delete inXSO.properties;
    inXSO.allOf = [ {
        xml: u.deepClone(inXSO.xml),
        type: 'object',
        properties: {}
    } ];

    let xso = lastXSO(inXSO.allOf);

    if (!restriction['undefined']) {
        // might be nested restriction
        if (restriction.simpleType && restriction.simpleType.restriction) {
            restriction = restriction.simpleType.restriction;
        }
    }
    var isXSD;
    if (restriction && restriction['undefined']) {
        isXSD = dictionary.isXSDType(restriction['undefined'].base, namespaces);
        let baseType = dictionary.bestMatch(restriction['undefined'].base, 'typedef', dictEntry, dict, namespaces);
        if (baseType) {
            xso.type = baseType;
        } else {
            xso.type = 'string';
        }
        delete xso.properties;
    } else {
        dictionary.annotateError(dictEntry.schema, g.http(u.r(dict.req)).f('The \'base\' of a restriction is missing.  The schema object is mapped to a string.'));
        xso.type = 'string';
        return;
    }

    // Set the facetxso to the type where facets are added.
    let facetxso = xso;
    let typeDictEntry = dict.dictEntry[xso.type];
    if (typeDictEntry && typeDictEntry.schemaType === 'typeOf') {
        typeDictEntry = dict.dictEntry[typeDictEntry.typeNSName];
    }
    if (!isXSD && typeDictEntry) {
        if (dictEntry.schema['undefined'] && dictEntry.schema['undefined'].name == xso.type) {
            // stop hard cycles due to weird schema name clashes
            let swaggerType = mapXSDTypeToSwagger(xso.type, dict);
            u.extendObject(xso, swaggerType);
        } else {
            addReference(refMap, xso.type, {});
            if (isPrimitiveType(typeDictEntry, namespaces)) {
                // If directly referenced base is just a type whose base is an xsd type, them set it directly.
                let primitiveRef = generateSwaggerXSO(typeDictEntry, dict, refMap, namespaces);
                delete xso.type;
                if (primitiveRef.properties && _.isEmpty(primitiveRef.properties) &&
                    primitiveRef.type && primitiveRef.type !== 'object') {
                    // Remove unnecessary properties field
                    delete primitiveRef.properties;
                }
                delete primitiveRef.xml; // existing obj will already have its namespace
                u.extendObject(xso, primitiveRef);
            } else if (typeDictEntry) {
                // Generate the referenced base and copy it into the current object
                let baseXSO = generateSwaggerXSO(typeDictEntry, dict, refMap, namespaces);
                delete xso.type;
                if (baseXSO.properties && _.isEmpty(baseXSO.properties) &&
                    baseXSO.type && baseXSO.type !== 'object') {
                    // Remove unnecessary properties field
                    delete baseXSO.properties;
                }
                delete baseXSO.xml; // existing obj will already have its namespace
                u.extendObject(xso, baseXSO);
                // If the new xso has an allOf, we might need to repeat to get the actual type (uncommon)
                if (xso.allOf) {
                    facetxso = xso.allOf[xso.allOf.length - 1];
                    if (facetxso.type == 'object'  && xso.allOf[0]['$ref']) {
                        let nsName = u.getDefNameFromRef(xso.allOf[0]['$ref']);
                        if (dict.dictEntry[nsName]) {
                            let base2XSO = generateSwaggerXSO(dict.dictEntry[nsName], dict, refMap, namespaces);

                            if (base2XSO.type || base2XSO.allOf && base2XSO.allOf[0].type) {
                                if (base2XSO.allOf && base2XSO.allOf[0].type) {
                                    base2XSO = base2XSO.allOf[0];
                                }
                                delete facetxso.type;
                                delete base2XSO.xml; // existing obj will already have its namespace
                                delete base2XSO.properties;  // Remove properties because they available in the base
                                delete base2XSO.required;
                                u.extendObject(facetxso, base2XSO);
                            } else {
                                facetxso = xso;
                            }
                        }
                    }
                }
            } else {
                // Fallback...may not ever get here
                var ref = '#/definitions/' + xso.type;
                delete xso.type;
                xso.allOf = [];
                xso.allOf[0] = { $ref: ref };
                xso.allOf[1] = { type: 'string' };  // Guess
                facetxso = xso.allOf[1];  // set the facetxso to the allOf object containing the type.
            }
        }
    } else {
        let swaggerType = mapXSDTypeToSwagger(u.stripNamespace(restriction['undefined'].base), dict);
        u.extendObject(xso, swaggerType);
    }

    // Now process the facets
    if (restriction.pattern) {
        var patterns = u.makeSureItsAnArray(restriction.pattern);
        var patLen = patterns.length;
        if (patLen == 1) {
            facetxso.pattern = patterns[0]['undefined'].value;
        } else {
            // in odd cases where more than one pattern is supplied, we must combine into one regex
            facetxso.pattern = '(' + patterns[0]['undefined'].value + ')';
            for (let i = 1; i < patLen; i++) {
                var pat = patterns[i];
                facetxso.pattern += '|(' + pat['undefined'].value + ')';
            } // end for
        }
    }

    if (restriction.whiteSpace) {
        if (typeof restriction.whiteSpace['undefined'].value !== 'undefined') {
            facetxso['x-ibm-whiteSpace'] = restriction.whiteSpace['undefined'].value;
        }
    }
    if (restriction.fractionDigits) {
        if (typeof restriction.fractionDigits['undefined'].value !== 'undefined') {
            let value = parseInt(restriction.fractionDigits['undefined'].value);
            facetxso['x-ibm-fractionDigits'] = value;
        }
    }
    if (restriction.totalDigits) {
        if (typeof restriction.totalDigits['undefined'].value !== 'undefined') {
            let value = parseInt(restriction.totalDigits['undefined'].value);
            facetxso['x-ibm-totalDigits'] = value;
        }
    }
    if (restriction.maxLength) {
        if (typeof restriction.maxLength['undefined'].value !== 'undefined') {
            let value = parseInt(restriction.maxLength['undefined'].value);
            facetxso.maxLength = value;
        }
    }
    if (restriction.minLength) {
        if (typeof restriction.minLength['undefined'].value !== 'undefined') {
            let value = parseInt(restriction.minLength['undefined'].value);
            facetxso.minLength = value;
        }
    }
    if (restriction['length']) {
        if (typeof restriction['length']['undefined'].value !== 'undefined') {
            let value = parseInt(restriction['length']['undefined'].value);
            facetxso.minLength = value;
            facetxso.maxLength = value;
        }
    }
    if (restriction.enumeration) {
        let enums = u.makeSureItsAnArray(restriction.enumeration);
        facetxso['enum'] = [];
        var enumsLen = enums.length;
        for (let i = 0; i < enumsLen; i++) {
            let enm = enums[i];
            // render as string and will adjust value in post processing
            let value = enm['undefined'].value;
            facetxso['enum'].push(value);
        } // end for
    }

    // map min and max after we've put the default limits in per type so that the schema can override
    if (restriction.minInclusive) {
        facetxso.minimum = getFacetNumeric(restriction.minInclusive['undefined'].value, facetxso);
    }
    if (restriction.minExclusive) {
        facetxso.minimum = getFacetNumeric(restriction.minExclusive['undefined'].value, facetxso);
        facetxso.exclusiveMinimum = true;
    }
    if (restriction.maxInclusive) {
        facetxso.maximum = getFacetNumeric(restriction.maxInclusive['undefined'].value, facetxso);
    }
    if (restriction.maxExclusive) {
        facetxso.maximum = getFacetNumeric(restriction.maxExclusive['undefined'].value, facetxso);
        facetxso.exclusiveMaximum = true;
    }

    if (restriction.anyAttribute) {
        // Ignore
    }
    if (restriction.attribute) {
        handleAttributeRef(restriction.attribute, dictEntry, dict, refMap, inXSO.allOf, namespaces, dictEntry.tns);
    }
    if (restriction.attributeGroup) {
        handleAttributeGroupRef(restriction.attributeGroup, dictEntry, dict, refMap, inXSO.allOf, namespaces, dictEntry.tns);
    }
}

function getFacetNumeric(facetValue, xso) {
    if (xso.type != 'integer' || xso.type != 'number') {
        return u.parseToPrimitive(facetValue);
    } else if (xso.type == 'number' && (xso.format == 'float' || xso.format == 'double')) {
        return parseFloat(facetValue);
    }
    return parseInt(facetValue);
}

/**
* return the occurrence information for a construct
*/
function processOccurrence(schema) {
    let occur = { minOccurs: 1, maxOccurs: 1 };
    if (schema && schema['undefined']) {
        occur.minOccurs = getOccurrence(schema['undefined'].minOccurs);
        occur.maxOccurs = getOccurrence(schema['undefined'].maxOccurs);
    }
    return occur;
}

function lastXSO(list) {
    return list[list.length - 1];
}

function newXSO(list, reuseIfEmpty) {
    let last = lastXSO(list);
    if (reuseIfEmpty &&
        last.type == 'object' &&
        last.properties && Object.keys(last.properties).length === 0) {
        return last;
    }
    list.push({
        xml: u.deepClone(last.xml),
        type: 'object',
        properties: {}
    });
    return lastXSO(list);
}

/**
* handle a sequence ref
*/
function handleSequenceRef(sequence, dictEntry, dict, refMap, xsoList, namespaces, tns) {
    let occur = processOccurrence(sequence);
    let currXSOList = getXSOList(occur, xsoList, 'sequence');
    return handleSequenceContent(sequence, dictEntry, dict, refMap, currXSOList, namespaces, tns);
}

function getXSOList(occur, xsoList, statementName) {
    let currXSOList;
    if (occur.minOccurs != 1 || occur.maxOccurs != 1) {
        let xso = lastXSO(xsoList);
        xso.allOf = [ {
            type: 'array',
            items: {
                allOf: [ u.deepClone(xso) ]
            },
            minItems: (occur.minOccurs === -1  || occur.minOccurs === 0) ? undefined : occur.minOccurs,
            maxItems: (occur.maxOccurs === -1) ? undefined : occur.maxOccurs,
            'x-ibm-group': [ statementName ]
        } ];
        delete xso.type;
        delete xso.properties;
        currXSOList = xso.allOf[0].items.allOf;
    } else {
        let xso = lastXSO(xsoList);
        xso.allOf = [ u.deepClone(xso) ];
        delete xso.type;
        delete xso.properties;
        currXSOList = xso.allOf;
    }
    return currXSOList;
}

/**
*  handle the content of a sequence
*/
function handleSequenceContent(sequence, dictEntry, dict, refMap, xsoList, namespaces, tns) {
    let xso = lastXSO(xsoList);
    if ('any' in sequence) {
        xso.additionalProperties = true;
    }
    var items = [];
    var id = 0;
    var i;
    var order;
    let kinds = 0;

    /**
    * We want to process the element, choice, sequence, and group constructs in the
    * declared order so that the properties have the same order as the schema.
    * Put the constructs into an items map using the apicID key (which we added during preParse)
    */
    if (sequence.any) {
        kinds++;
        let anys = u.deepClone(u.makeSureItsAnArray(sequence.any));
        for (i = 0; i < anys.length; i++) {
            if (anyElementsOrAttributes(true, anys[i], dict, tns).length > 0) {
                if (anys[i]['undefined'].apicID) {
                    order = parseInt(anys[i]['undefined'].apicID);
                } else {
                    order = id++;
                }
                items.push({ type: 'any', order: order, value: anys[i] });
            }
        }
    }
    if (sequence.element) {
        kinds++;
        var elements = u.deepClone(u.makeSureItsAnArray(sequence.element));
        for (i = 0; i < elements.length; i++) {
            if (elements[i]['undefined'].apicID) {
                order = parseInt(elements[i]['undefined'].apicID);
            } else {
                order = id++;
            }
            items.push({ type: 'element', order: order, value: [ elements[i] ] });
        }
    }

    if (sequence.choice) {
        var choices = u.deepClone(u.makeSureItsAnArray(sequence.choice));
        for (i = 0; i < choices.length; i++) {
            kinds++;
            if (choices[i]['undefined'].apicID) {
                order = parseInt(choices[i]['undefined'].apicID);
            } else {
                order = id++;
            }
            items.push({ type: 'choice', order: order, value: choices[i] });
        }
    }

    if (sequence.group) {
        var groups = u.deepClone(u.makeSureItsAnArray(sequence.group));
        for (i = 0; i < groups.length; i++) {
            kinds++;
            if (groups[i]['undefined'].apicID) {
                order = parseInt(groups[i]['undefined'].apicID);
            } else {
                order = id++;
            }
            items.push({ type: 'group', order: order, value: groups[i] });
        }
    }

    if (sequence.sequence) {
        var sequences = u.deepClone(u.makeSureItsAnArray(sequence.sequence));
        for (i = 0; i < sequences.length; i++) {
            kinds++;
            if (sequences[i]['undefined'].apicID) {
                order = parseInt(sequences[i]['undefined'].apicID);
            } else {
                order = id++;
            }
            items.push({ type: 'sequence', order: order, value: sequences[i] });
        }
    }

    // If different kinds, then use an allOf to model the nesting

    // Now sort the keys so that we process the constructs in the declared order
    items.sort(function(a, b) {
        return a.order - b.order;
    });

    // Process the constructs
    let len = items.length;
    let lastItem = null;
    for (var k = 0; k < len; k++) {
        if (!lastItem ||
            lastItem === 'element'  &&
            items[k].type === 'element' &&
            lastXSO(xsoList).properties) {
            // Reuse last xso
        } else {
            newXSO(xsoList);
        }
        if (items[k].type == 'element') {
            for (let m = 0; m < items[k].value.length; m++) {
                if (isElementSubstitutionGroup(items[k].value[m], dictEntry, dict, namespaces)) {
                    handleSubstitutionGroupRef(items[k].value[m], dictEntry, dict, refMap, xsoList, namespaces, tns);
                } else {
                    handleElement(items[k].value[m], dictEntry, dict, refMap, xsoList, namespaces, tns);
                }
            }
        } else if (items[k].type == 'any') {
            handleStrictAnyRef(items[k].value, dictEntry, dict, refMap, xsoList, namespaces, tns);
        } else if (items[k].type == 'choice') {
            handleChoiceRef(items[k].value, dictEntry, dict, refMap, xsoList, namespaces, tns);
        } else if (items[k].type == 'group') {
            handleGroupRef(items[k].value, dictEntry, dict, refMap, xsoList, namespaces, tns);
        } else if (items[k].type == 'sequence') {
            handleSequenceRef(items[k].value, dictEntry, dict, refMap, xsoList, namespaces, tns);
        }
        lastItem = items[k].type;
    }
}

function anyElementsOrAttributes(isAny, any, dict, tns) {
    let ns = [];
    if (any['undefined'] && (!any['undefined'].processContents || any['undefined'].processContents === 'strict')) {
        let namespaces = any['undefined'].namespace;
        if (!namespaces) {
            return [];
        }
        namespaces = _.split(namespaces, ',');
        for (let i = 0; i < namespaces.length; i++) {
            let namespace = namespaces[i].trim();
            if (namespace == '##any') {
                return [];
            } else if (namespace == '##local') {
                return [];
            } else if (namespace == '##targetNamespace') {
                ns.push(tns);
            } else if (namespace == '##other') {
                ns = _.difference(Object.keys(dict.schemaElements), [ tns ]);
            } else {
                ns.push(namespace);
            }
        }
    }
    let rc = [];
    for (let i = 0; i < ns.length; i++) {
        let list = (isAny) ? dict.schemaElements[ns[i]] : dict.schemaAttributes[ns[i]];
        rc = _.union(rc, list);
    }
    if (rc.length > 50) {
        return [];
    }
    return rc;
}

function isElementSubstitutionGroup(schema, dictEntry, dict, namespaces) {
    if (schema['undefined'] && schema['undefined'].ref) {
        let nsName = dictionary.bestMatch(schema['undefined'].ref, 'element', dictEntry, dict, namespaces);
        let eDictEntry = dict.dictEntry[nsName];
        return eDictEntry && eDictEntry.substitutions;
    }
    return false;
}

/*
* handle a choice reference
*/
function handleChoiceRef(choice, dictEntry, dict, refMap, xsoList, namespaces, tns) {
    let occur = processOccurrence(choice);
    let currXSOList = getXSOList(occur, xsoList, 'choice');
    return handleChoiceContent(choice, dictEntry, dict, refMap, currXSOList, namespaces, tns);
}

/**
*  Handle the contents of a choice
*/
function handleChoiceContent(choice, dictEntry, dict, refMap, xsoList, namespaces, tns) {
    // Use a oneOf to represent the choice.
    // The oneOf construct is not supported in openAPI 2.0, so it is removed during postGeneration
    let xso = lastXSO(xsoList);
    xso.allOf = [ u.deepClone(xso),
        {
            xml: u.deepClone(xso.xml),
            oneOf: []
        } ];
    delete xso.type;
    delete xso.properties;
    let oneOf = xso.allOf[1].oneOf;
    oneOf.push({
        xml: u.deepClone(xso.xml),
        type: 'object',
        properties: {},
    });
    let first = true;

    // Most choice constructs contain just elements, let's call this
    // the basic pattern.  In more complicated cases, there could
    // be any, group, sequence or other nested choices.
    // If this is the basic pattern, mark each of the elements with
    // a bread-crumb so that the example generator can add instructive comments.
    let basicPattern = true;

    if ('any' in choice) {
        basicPattern = false;
        xso.additionalProperties = true;
        lastXSO(oneOf).additionalProperties = true;
        first = false;
    }
    if (choice.any) {
        basicPattern = false;
        let anys = u.deepClone(u.makeSureItsAnArray(choice.any));
        for (let i = 0; i < anys.length; i++) {
            if (anyElementsOrAttributes(true, anys[i], dict, tns).length > 0) {
                handleStrictAnyRef(anys[i], dictEntry, dict, refMap, oneOf, namespaces, tns);
            }
        }
    }
    if (choice.element) {
        var elements = u.deepClone(u.makeSureItsAnArray(choice.element));
        for (let i = 0; i < elements.length; i++) {
            if (!first) {
                newXSO(oneOf);
            }
            first = false;
            if (isElementSubstitutionGroup(elements[i], dictEntry, dict, namespaces)) {
                handleSubstitutionGroupRef(elements[i], dictEntry, dict, refMap, oneOf, namespaces, tns);
            } else {
                handleElement(elements[i], dictEntry, dict, refMap, oneOf, namespaces, tns);
            }
        }
    }

    if (choice.sequence) {
        basicPattern = false;
        let sequence = u.deepClone(u.makeSureItsAnArray(choice.sequence));
        for (let i = 0; i < sequence.length; i++) {
            if (!first) {
                newXSO(oneOf);
            }
            first = false;
            handleSequenceRef(sequence[i], dictEntry, dict, refMap, oneOf, namespaces, tns);
        }
    }

    if (choice.group) {
        basicPattern = false;
        let group = u.deepClone(u.makeSureItsAnArray(choice.group));
        for (let i = 0; i < group.length; i++) {
            if (!first) {
                newXSO(oneOf);
            }
            first = false;
            handleGroupRef(group[i], dictEntry, dict, refMap, oneOf, namespaces, tns);
        }
    }

    if (choice.choice) {
        basicPattern = false;
        choice.choice = u.deepClone(u.makeSureItsAnArray(choice.choice));
        for (let i = 0; i < choice.choice.length; i++) {
            if (!first) {
                newXSO(oneOf);
            }
            first = false;
            handleChoiceRef(choice.choice[i], dictEntry, dict, refMap, oneOf, namespaces, tns);
        }
    }

    // If this is a basic choice and the choice will not be rendered as a oneOf
    // then mark each of the property so that we can detect that it is in a choice.
    if (basicPattern && oneOf && oneOf.length > 1 && !dict.createOptions.v3oneOf) {
        dict.basicChoice = dict.basicChoice ? dict.basicChoice + 1 : 1;
        oneOf.forEach(function(xso) {
            if (xso.properties) {
                let propNames = Object.keys(xso.properties);
                if (propNames.length == 1) {
                    xso.properties[propNames[0]]['x-ibm-basic-choice'] = dict.basicChoice;
                }
            }
        });
    }
}

/*
* handle a strict any reference
*/
function handleStrictAnyRef(any, dictEntry, dict, refMap, xsoList, namespaces, tns) {
    let occur = processOccurrence(any);
    let currXSOList = getXSOList(occur, xsoList, 'any');
    return handleStrictAnyContent(any, dictEntry, dict, refMap, currXSOList, namespaces, tns);
}

/**
*  Handle the contents of a strict any
*/
function handleStrictAnyContent(any, dictEntry, dict, refMap, xsoList, namespaces, tns) {
    // Use a oneOf to represent the strict any.
    // The oneOf construct is not supported in openAPI 2.0, so it is removed during postGeneration
    let xso = lastXSO(xsoList);
    xso.allOf = [ u.deepClone(xso),
        {
            xml: u.deepClone(xso.xml),
            oneOf: []
        } ];
    delete xso.type;
    delete xso.properties;
    let oneOf = xso.allOf[1].oneOf;
    oneOf.push({
        xml: u.deepClone(xso.xml),
        type: 'object',
        properties: {},
    });
    let nsNames = anyElementsOrAttributes(true, any, dict, tns);
    let first = true;

    for (let i = 0; i < nsNames.length; i++) {
        if (!first) {
            newXSO(oneOf);
        }
        first = false;
        addReference(refMap, nsNames[i], {});
        let propName = nsNames[i].substring(0, nsNames[i].indexOf('_element'));
        let o = xso.allOf[1].oneOf[xso.allOf[1].oneOf.length - 1];
        o.properties[propName] = {
            $ref: '#/definitions/' + nsNames[i]
        };
    }
}

/**
*  Handle the all reference
*/
function handleAllRef(all, dictEntry, dict, refMap, xsoList, namespaces, tns) {
    let occur = processOccurrence(all);
    let currXSOList = getXSOList(occur, xsoList, 'all');
    return handleAllContent(all, dictEntry, dict, refMap, currXSOList, namespaces, tns);
}

/**
*  Handle the all construct content
*/
function handleAllContent(all, dictEntry, dict, refMap, xsoList, namespaces, tns) {

    // Only elements are allowed within an all construct.
    // The choice, sequence, and group contructs are not allowed.
    var elements = [];
    if (all.element) {
        elements = u.deepClone(u.makeSureItsAnArray(all.element));
    }

    // for an all condition we set the implied minOccurs value to 1 unless already switched off
    var required = true;
    if (all['undefined']) {
        // can have a minOccurs at the "all" level to switch the logic
        var minOccurs = all['undefined'].minOccurs;
        if (minOccurs === 0) {
            required = false;
        }
    }
    if (required) {
        var len = elements.length;
        for (var i = 0; i < len; i++) {
            var element = elements[i];
            // only set the required flag if no minimum already set
            if (typeof element['undefined'].minOccurs === 'undefined') {
                element['undefined'].minOccurs = 1;
            }
        } // end for
    }
    for (let i = 0; i < elements.length; i++) {
        if (isElementSubstitutionGroup(elements[i], dictEntry, dict, namespaces)) {
            handleSubstitutionGroupRef(elements[i], dictEntry, dict, refMap, xsoList, namespaces, tns);
        } else {
            handleElement(elements[i], dictEntry, dict, refMap, xsoList, namespaces, tns);
        }
    }
}

/**
* @return true if sequence group all or choice
*/
function isSGAC(obj) {
    return obj && (obj.sequence || obj.group || obj.all || obj.choice);
}

/**
* handle a sequence group all or choice reference
*/
function handleSGACRef(obj, dictEntry, dict, typesFound, xsoList, namespaces, tns) {
    if (obj.sequence) {
        handleSequenceRef(obj.sequence, dictEntry, dict, typesFound, xsoList, namespaces, tns);
    } else if (obj.group) {
        handleGroupRef(obj.group, dictEntry, dict, typesFound, xsoList, namespaces, tns);
    } else if (obj.all) {
        handleAllRef(obj.all, dictEntry, dict, typesFound, xsoList, namespaces, tns);
    } else if (obj.choice) {
        handleChoiceRef(obj.choice, dictEntry, dict, typesFound, xsoList, namespaces, tns);
    }
}

/**
* handle a group reference
*/
function handleSubstitutionGroupRef(schema, dictEntry, dict, refMap, xsoList, namespaces, tns) {
    if (!schema['undefined'] || !schema['undefined'].ref) {
        return;  // There is no such thing as a group without a ref
    }
    let sgNSName = dictionary.resolveNameInNamespace(schema['undefined'].ref, 'substitutionGroup', dictEntry.xmlns, namespaces, dictEntry.tns, dict);
    let sgDictEntry = dict.dictEntry[sgNSName];
    if (!sgDictEntry) {
        return;
    }
    let occur = processOccurrence(schema);

    let xso = newXSO(xsoList, true);
    delete xso.type;
    delete xso.properties;
    delete xso.xml;
    addReference(refMap, sgNSName, {});
    if (occur.minOccurs != 1 || occur.maxOccurs != 1) {
        xso.allOf = [ {
            type: 'array',
            items: {
                allOf: [ {
                    $ref: '#/definitions/' + sgNSName,
                } ]
            },
            minItems: (occur.minOccurs === -1  || occur.minOccurs === 0) ? undefined : occur.minOccurs,
            maxItems: (occur.maxOccurs === -1) ? undefined : occur.maxOccurs,
            'x-ibm-group': [ sgNSName ]
        } ];
    } else {
        xso.$ref = '#/definitions/' + sgNSName;
    }
}

/**
* handle a group reference
*/
function handleGroupRef(group, dictEntry, dict, refMap, xsoList, namespaces, tns) {
    let req = dict.req;
    if (!group['undefined'] || !group['undefined'].ref) {
        return;  // There is no such thing as a group without a ref
    }
    let groupNSName = dictionary.resolveNameInNamespace(group['undefined'].ref, 'group', dictEntry.xmlns, namespaces, dictEntry.tns, dict);
    let groupDictEntry = dict.dictEntry[groupNSName];
    if (!groupDictEntry) {
        dictionary.annotateError(dictEntry.schema, g.http(u.r(req)).f('The \'ref\' of \'group\' %s could not be found.  The group refererence is ignored', group['undefined'].ref));
        return;
    }
    let occur = processOccurrence(group);
    let xso = newXSO(xsoList, true);
    delete xso.type;
    delete xso.properties;
    delete xso.xml;
    addReference(refMap, groupNSName, {});
    if (occur.minOccurs != 1 || occur.maxOccurs != 1) {
        xso.allOf = [ {
            type: 'array',
            items: {
                allOf: [ {
                    $ref: '#/definitions/' + groupNSName
                } ]
            },
            minItems: (occur.minOccurs === -1  || occur.minOccurs === 0) ? undefined : occur.minOccurs,
            maxItems: (occur.maxOccurs === -1) ? undefined : occur.maxOccurs,
            'x-ibm-group': [ groupNSName ]
        } ];
    } else {
        xso.$ref = '#/definitions/' + groupNSName;
    }
}

/**
*  Handle the content of a group.
*/
function handleGroupContent(group, dictEntry, dict, refMap, xsoList, namespaces, tns) {

    // Only sequence, group or all is allowed within a group.
    // And only one of them is allowed.

    let req = dict.req;
    let countConstructs = 0;
    if (group.choice) {
        group.choice = u.makeSureItsAnArray(group.choice);

        countConstructs += group.choice.length;
        handleChoiceRef(group.choice[0], dictEntry, dict, refMap, xsoList, namespaces, tns);
    }
    // look for nested sequences
    if (group.sequence) {
        let sequences = [];
        sequences = u.makeSureItsAnArray(group.sequence);
        countConstructs += sequences.length;
        handleSequenceRef(sequences[0], dictEntry, dict, refMap, xsoList, namespaces, tns);
    } // end for

    // look for nested all
    if (group.all) {
        let alls = u.makeSureItsAnArray(group.all);
        let allLen = alls.length;
        countConstructs += allLen;
        handleAllRef(alls[0], dictEntry, dict, refMap, xsoList, namespaces, tns);
    }
    if (countConstructs > 1) {
        dictionary.annotateWarning(dictEntry.schema, g.http(u.r(req)).f('A \'group\' may only contain one \'sequence\', one \'choice\', or one \'all\' element. Each is processed, but this not compliant with the schema specification.'));
    }
}

/**
*  Called during XSO generation to process an attributeGroup
*/
function handleAttributeGroupRef(inGroup, dictEntry, dict, refMap, xsoList, namespaces, tns) {
    let attrGroups = u.makeSureItsAnArray(inGroup);
    for (var i = 0; i < attrGroups.length; i++) {
        let attrGroup = attrGroups[i];
        let attrRef = attrGroup['undefined'].ref;
        if (attrRef) {
            let nsName = dictionary.bestMatch(attrRef, 'attributeGroup', dictEntry, dict, namespaces);
            let xso = newXSO(xsoList); // Create a new xso for the substitution group
            delete xso.type;
            delete xso.properties;
            delete xso.xml;
            xso.$ref = '#/definitions/' + nsName;
            addReference(refMap, nsName, {});
        }
    }
}

/**
*  Called during XSO generation to process an attribute reference
*/
function handleAttributeRef(inAttr, dictEntry, dict, refMap, xsoList, namespaces, tns) {
    var attributes = u.makeSureItsAnArray(inAttr);
    var len = attributes.length;
    let xso = newXSO(xsoList);
    xso.xml = { namespace: '' };
    for (var i = 0; i < len; i++) {
        var attribute = attributes[i];
        var qualifiedAttr = dictEntry.qualifiedAttr;
        if (attribute['undefined'].form) {
            qualifiedAttr = (attribute['undefined'].form == 'qualified');
        }
        var newProp = {
            xml: {
                namespace: '',
                attribute: true
            },
            type: 'string'  // This is the default if the type/ref is not found.
        };

        var name = attribute['undefined'].name;

        // There are four choices
        // 1. Attribute can be defined by a ref
        // 2. Attribute is a built-in type
        // 3. Attribute is defined inlineRet
        // 4. Attribute is defined by a non-built-in type

        var attrRef = attribute['undefined'].ref;
        var nsName = null;
        var isXSD = false;
        let attributeDefaultValue = null;
        if (attrRef) {
            nsName = dictionary.bestMatch(attribute['undefined'].ref, 'attribute', dictEntry, dict, namespaces);
            attributeDefaultValue = (dict.dictEntry[nsName] && dict.dictEntry[nsName].tagInfo && dict.dictEntry[nsName].tagInfo.default);
        } else if (attribute['undefined'].type) {
            nsName = dictionary.bestMatch(attribute['undefined'].type, 'type', dictEntry, dict, namespaces);
            isXSD = dictionary.isXSDType(attribute['undefined'].type, namespaces, dictEntry.xmlns);
        }
        if (attrRef) {
            // 1. Attribute ref
            name = u.stripNamespace(attrRef); // The name is defined by the ref
            if (dict.dictEntry[nsName]) {
                newProp = {
                    $ref: '#/definitions/' + nsName
                };
                addReference(refMap, nsName, {});
            }
        } else if (isXSD) {
            // 2. Attribute is a built-in type
            var swaggerType = mapXSDTypeToSwagger(u.stripNamespace(attribute['undefined'].type), dict);
            newProp.type = swaggerType.type;
            if (qualifiedAttr) {
                if (tns) {
                    newProp.xml.namespace = tns;
                    newProp.xml.prefix = u.getPrefixForNamespace(tns, namespaces);
                }
            }
            u.extendObject(newProp, swaggerType);
        } else if (!nsName) {
            // 3. Attribute is defined inline
            newProp.type = 'string'; // Assume string
            if (attribute.simpleType) {
                var simpleSchema = {
                    tns: '',
                    schemaType: 'simple',
                    schema: attribute.simpleType,
                    xmlns: dictEntry.xmlns
                };
                var inlineRet = generateSwaggerXSO(simpleSchema, dict, refMap, namespaces);
                newProp.type = inlineRet.type;
                if (qualifiedAttr) {
                    if (tns) {
                        newProp.xml.namespace = tns;
                        newProp.xml.prefix = u.getPrefixForNamespace(tns, namespaces);
                    }
                }
                extendXSO(newProp, inlineRet);
            }
        } else {
            // 4. Attribute is defined by a type that is not a built-in
            // An attribute is referencing a simple type.  We need to generate a definition that is suitable for an attribute.
            if (dict.dictEntry[nsName]) {
                addReference(refMap, nsName, {});
                let referencingContext = {
                    ns: (qualifiedAttr) ? tns : UNQUALNS,
                    attribute: true
                };
                addReference(refMap, nsName, referencingContext);
                newProp = {
                    $ref: '#/definitions/' + getDefinitionName(nsName, referencingContext, namespaces)
                };
            }
        }

        // Add default if either default or fixed is specified.
        if ('default' in attribute['undefined']) {
            newProp.default = attribute['undefined'].default;
        }
        if ('fixed' in attribute['undefined']) {
            newProp.default = attribute['undefined'].fixed;
        }
        if (attributeDefaultValue) {
            newProp.default = attributeDefaultValue;
        }

        if (xso.properties[name] || xso.properties[name] === {}) {
            xso = newXSO(xsoList);
        }

        // If required, then add it to the required list
        // (Note we could add a default, but the mapper has code to pick a reasonable default for each type)
        if (attribute['undefined'].use == 'required') {
            if (!xso.required) {
                xso.required = [];
            }
            xso.required = xso.required.concat(name);
        }

        // If prohibited, add it and it will be marked for removal during postProcessing
        if (attribute['undefined'].use == 'prohibited') {
            newProp['x-prohibited'] = true;
        }

        if (attribute.annotation) {
            // include annotation as description
            if (attribute.annotation.documentation) {
                var doc = u.cleanupDocumentation(attribute.annotation.documentation, dict.req);
                if (attrRef && CHILD_DESCRIPTION_PLACED_ON_PARENT) {
                    // if the attr is a reference we cant use description at the element level
                    // move it up to the parent container
                    if (xso.description) {
                        xso.description += ';\n' + name + ': ' + doc;
                    } else {
                        xso.description = name + ': ' + doc;
                    }
                } else if (newProp.description) {
                    newProp.description += ';\n' + doc;
                } else {
                    newProp.description = doc;
                }
            }
            if (attribute.annotation.apic) {
                newProp['x-ibm-messages'] = attribute.annotation.apic;
            }
        }
        xso.properties[name] = newProp;
    } // end for
}

/**
 * Process the child element of a sequence, choice, all, etc.
 * @param elements is the list of schema elements
 * @param dictEntry is the referencing dictionary entry
 * @param dict is the global "dictionary" object
 * @param refMap is the map of the references.  Any discovered references are added to the map
 * @param xsoList is the swagger.definition containing child element (properties)
 * @param namespaces is the namespace list
 * @param tns is the namespace of the referencing type
 */
function handleElement(element, dictEntry, dict, refMap, xsoList, namespaces, tns) {
    let req = dict.req;
    let xso = lastXSO(xsoList);
    if (u.useAsserts) {
        assert(tns == null || typeof tns == 'string',
        'expected typeNamespace of string, not ' + util.inspect(tns));
    }
    var refType;
    // Determine if the schema is qualified or not qualified
    var schemaQualified = false;
    if (dictEntry && dictEntry.qualified) {
        schemaQualified = true;
    }
    var elemName = element['undefined'].name;

    // Now determine if the child is qualified
    var childQualified = schemaQualified;
    var elemQualified = element['undefined'].form;
    if (elemQualified) {
        if (elemQualified == 'qualified') {
            childQualified = true;
        } else if (elemQualified == 'unqualified') {
            childQualified = false;
        }
    }
    var elemNillable = false;
    var elemNillableAttr = element['undefined'].nillable;
    if (elemNillableAttr && elemNillableAttr.toLowerCase() === 'true') {
        elemNillable = true;
    }
    var elemTypeOrRef = '';
    var isXSD = false;
    var isElemRef = false;
    let isAbstractElement = false;
    let elementDefaultValue = null;
    if (elemName) {
        isXSD = dictionary.isXSDType(element['undefined'].type, namespaces, dictEntry.xmlns);
        elemTypeOrRef = dictionary.bestMatch(element['undefined'].type, 'type', dictEntry, dict, namespaces);
    } else {
        // might be a direct reference to another type
        if (element['undefined'].ref) {
            elemTypeOrRef = dictionary.bestMatch(element['undefined'].ref, 'element', dictEntry, dict, namespaces);
            elemName = u.stripNamespace(element['undefined'].ref);
            isElemRef = true;
            // The referenced root element may have the nillable attribute
            let tagInfo = dict.dictEntry[elemTypeOrRef] ? dict.dictEntry[elemTypeOrRef].tagInfo : null;
            elemNillable = tagInfo && tagInfo.nillable;
            isAbstractElement = tagInfo && tagInfo.abstract;
            elementDefaultValue = tagInfo && tagInfo.default;
        }
    }
    var isReference = false;
    let propXSO = {};
    propXSO[elemName] = xso;

    if ('unique' in element) {
        dictionary.annotateInfo(element, g.http(u.r(req)).f('The \'unique\' element is ignored.'));
    }

    if ('nillable' in element['undefined'] && element['undefined'].ref) {
        dictionary.annotateError(element, g.http(u.r(req)).f('An element cannot have \`ref\' and \'nillable\'.'));
    }

    if (!isXSD && elemTypeOrRef && dict.dictEntry[elemTypeOrRef]) {
        // Flow to here indicates that the child element has a type or ref that
        // locates a type or element that is defined in a schema (but is not an xsd primitive).
        refType = dict.dictEntry[elemTypeOrRef];
        if (refType && refType.schemaType === 'typeOf') {
            refType = dict.dictEntry[refType.typeNSName];
        }

        // The referenced definition will contain an xml that matches the refType's qualified setting.
        // If the referencing qualification (childQualified) is different, then we need to create a
        // a duplicate definition.
        // We also need to a duplicate definition if both refrenced and referencing qualifications are qualified
        // but they are using different namespaces.
        // We only need to do this when the child element references a type (uses type attribute)
        // because element refeferences (uses ref attribute) will always use the referenced definitions xml.
        if (!isElemRef &&
            ((refType.qualified != childQualified) ||
             (refType.qualified && tns && refType.tns != tns))) {

            // Check the special case that this is a simpleType, and then set up the property has the primitive
            if (isPrimitiveType(refType, namespaces)) {
                var primitiveRef = generateSwaggerXSO(refType, dict, refMap, namespaces);
                // primitive types can be inlined directly
                detectPropertyCollision(elemName, xso.properties, element, dict.req);
                xso.properties[elemName] = primitiveRef;
                if (childQualified) {
                    xso.properties[elemName].xml = {
                        namespace: tns,
                        prefix: u.getPrefixForNamespace(tns, namespaces)
                    };
                } else {
                    xso.properties[elemName].xml = {
                        namespace: '',
                        prefix: ''
                    };
                }
            } else {
                // Add the referenced type to the list of found types and add the referencing namespace
                var referencingNS = (childQualified) ? tns : UNQUALNS;
                addReference(refMap, elemTypeOrRef, {});
                addReference(refMap, elemTypeOrRef, {
                    ns: referencingNS
                });

                // Now indicate that we need a duplicate definition that will have the proper qualification
                detectPropertyCollision(elemName, xso.properties, element, dict.req);
                let dupType = getDefinitionName(elemTypeOrRef, { ns: referencingNS }, namespaces);
                xso.properties[elemName] = {
                    $ref: '#/definitions/' + dupType
                };
                isReference = true;
            }
        } else {
            // reference is to another type - recurse
            addReference(refMap, elemTypeOrRef, {});
            detectPropertyCollision(elemName, xso.properties, element, dict.req);
            xso.properties[elemName] = {
                $ref: '#/definitions/' + elemTypeOrRef
            };
            isReference = true;
        }
    } else {
        var swaggerType = mapXSDTypeToSwagger(u.stripNamespace(element['undefined'].type), dict);
        detectPropertyCollision(elemName, xso.properties, element, dict.req);
        xso.properties[elemName] = swaggerType;
        if (!isElemRef) {
            if (childQualified) {
                xso.properties[elemName].xml = {
                    namespace: tns,
                    prefix: u.getPrefixForNamespace(tns, namespaces)
                };
            } else {
                xso.properties[elemName].xml = {
                    namespace: '',
                    prefix: ''
                };
            }
        }
    }


    // inner anonymous type
    if ('complexType' in element) {

        if (!element.complexType) {
            element.complexType = {};
        }

        var complexSchema = {
            tns: tns,
            schemaType: 'complex',
            schema: element.complexType,
            xmlns: dictEntry.xmlns,
            qualified: dictEntry.qualified,
            qualifiedAttr: dictEntry.qualifiedAttr
        };
        var referencingContext = {
            ns: UNQUALNS
        };
        if (childQualified) {
            referencingContext.ns = tns;
        }
        var typeRef = generateSwaggerXSO(complexSchema, dict, refMap, namespaces, referencingContext);

        xso.properties[elemName] = typeRef;
        if (xso.properties[elemName]['$ref']) {
            isReference = true;
        } else if (!xso.properties[elemName].type  &&
                   !xso.properties[elemName].allOf &&
                   !xso.properties[elemName].oneOf &&
                   !xso.properties[elemName].anyOf) {
            // If there is no type then this is a special case of a complexType with no content
            xso.properties[elemName].type = 'object';
            xso.properties[elemName].properties = {};
        }
    }
    if (element.simpleType) {
        var simpleSchema = {
            tns: tns,
            schemaType: 'simple',
            schema: element.simpleType,
            xmlns: dictEntry.xmlns,
            qualified: dictEntry.qualified,
            qualifiedAttr: dictEntry.qualifiedAttr
        };
        let referencingContextSimple = {
            ns: UNQUALNS
        };
        if (childQualified) {
            referencingContextSimple.ns = tns;
        }
        var simpleTypeRef = generateSwaggerXSO(simpleSchema, dict, refMap, namespaces, referencingContextSimple);
        xso.properties[elemName] = simpleTypeRef;
        if (xso.properties[elemName]['$ref']) {
            isReference = true;
        }
    }

    processElementOccurrence(element, propXSO, elemNillable, dict);

    // Map default or fixed to the swagger default property
    var item = (xso.properties[elemName].items != null) ? xso.properties[elemName].items : xso.properties[elemName];
    if ('fixed' in element['undefined']) {
        item.default = element['undefined'].fixed;
    }
    if ('default' in element['undefined']) {
        item.default = element['undefined'].default;
    }
    if (elementDefaultValue) {
        item.default = elementDefaultValue;
    }
    // If default and ref collision, then inline the ref
    if (item.default && item['$ref']) {
        // Get the xso of the ref and extend the item
        let defaultValue = item.default;
        delete item.default;
        let referencingContextSimple = {
            ns: UNQUALNS
        };
        if (childQualified) {
            referencingContextSimple.ns = tns;
        }
        let xso = generateSwaggerXSO(dict.dictEntry[u.getDefNameFromRef(item['$ref'])],
             dict, refMap, namespaces, referencingContextSimple);
        if (xso.typeOf) {
            xso = generateSwaggerXSO(dict.dictEntry[u.getDefNameFromRef(xso.typeOf['$ref'])],
                 dict, refMap, namespaces, referencingContextSimple);
        }
        delete item['$ref'];
        isReference = false;
        u.extendObject(item, xso);
        item.default = defaultValue;
    }

    if (element.annotation) {
        // include annotation as description
        if (element.annotation.documentation) {
            var doc = u.cleanupDocumentation(element.annotation.documentation, req);
            if (isReference && CHILD_DESCRIPTION_PLACED_ON_PARENT) {
                if (xso.description) {
                    xso.description += ';\n' + elemName + ': ' + doc;
                } else {
                    xso.description = elemName + ': ' + doc;
                }
            } else if (xso.properties[elemName].description) {
                xso.properties[elemName].description += ';\n' + doc;
            } else {
                xso.properties[elemName].description = doc;
            }
        }
        if (element.annotation.apic) {
            xso.properties[elemName]['x-ibm-messages'] = element.annotation.apic;
        }
    }

    // If abstract element, then remove the property.
    // Also remove from the required list
    if (isAbstractElement) {
        if (xso.properties[elemName]) {
            delete xso.properties[elemName];
        }
        if (xso.required && xso.required.length > 0) {
            let i = xso.required.indexOf(elemName);
            if (i >= 0) {
                xso.required.splice(i, 1);
            }
        }
    }
    if (xso.required && xso.required.length === 0) {
        delete xso.required;
    }
}

/**
* Process Occurrence attributes on the element
* @param element is the schema elements
* @param propXSO is an object of propNames to xsos
* @param elemNillable indicates if the element is nillable
* @param dict is the schema dictionary
**/
function processElementOccurrence(element, propXSO, elemNillable, dict) {
    // check required existence
    let minElement = getOccurrence(element['undefined'].minOccurs);
    let maxElement = getOccurrence(element['undefined'].maxOccurs);

    // If the property is required add it to the required list
    if (minElement != 0) {
        for (let propName in propXSO) {
            let xso = propXSO[propName];
            xso.required = xso.required || [];
            xso.required.push(propName);
        }
    }

    // See if the properties need to be rendered as an array with min and max items
    let maxItems = maxElement;
    let minItems = minElement;

    if (maxItems == -1 || maxItems > 1) {
        // we have an array type - switch out the content
        for (let propName in propXSO) {
            let xso = propXSO[propName];
            var existingContent = xso.properties[propName];
            xso.properties[propName] = {
                type: 'array',
                items: existingContent
            };
            if (maxItems > 1) {
                xso.properties[propName].maxItems = maxItems;
            }
            if (minItems > 0) {
                xso.properties[propName].minItems = minItems;
            }

            // For a child A, the namespace information for A is:
            //  i) if a non-array
            //     a) in the definition of the $ref -or
            //     b) in the xml construct -or
            //     c) the namespace in scope if neither (a or b)
            //  ii) if an array
            //     a) in the definition of the items.$ref -or
            //     b) in the items.xml construct -or
            //     c) the namespace in scope if neither (a or b)
            //
            // This can be confusing for an observer of arrays because it
            // seems that the xml should be directly under the A (not within the A.items object).
            // Also there could be hard to find bugs in the map runtime that assume
            // that the xml is directly under the A object.
            // So even though this is redundant, the code duplicates (boosts) the xml
            // information for the "uncommon" case that the items is an inlined object.
            if (xso.properties[propName].items.type &&
                xso.properties[propName].items.type == 'object' &&
                xso.properties[propName].items.xml) {
                xso.properties[propName].xml = u.deepClone(xso.properties[propName].items.xml);
            }
        }
    }

    // add nillable tag if found
    for (let propName in propXSO) {
        let xso = propXSO[propName];
        if (xso.properties && xso.properties[propName]) {
            if (elemNillable) {
                // If this is a $ref, the x-nullable tag is still added.
                // The fixupForNilAndNonNil function in postGenerate
                // will remove this tag and patch up the ref if necessary.
                xso.properties[propName]['x-nullable'] = true;
            }
        }
    }
    return;
}

/**
* Detect and issue a message if a property collision
*/
function detectPropertyCollision(key, properties, schema, req) {
    if (properties[key] || properties[key] === {}) {
        if (typeof properties[key] !== 'function') {
            // Indicate that a property collision occured and that the new property overrides the previous one.
            // Currently a message is annotated on the swagger, we could add code to resolve the collision by
            // mangling names.
            dictionary.annotateWarning(schema, g.http(u.r(req)).f('Multiple \'property\' fields with the name %s detected. The \'property\' is overwritten.', key));
        }
    }
}

/**
* Return the occurrence (or -1 if unbounded)
*/
function getOccurrence(occurs) {
    if (occurs === undefined || occurs === null) {
        return 1;
    } else if (typeof occurs === 'number') {
        return occurs;
    } else if (typeof occurs === 'string' && occurs.toLowerCase() == 'unbounded') {
        return -1;
    } else {
        return parseInt(occurs);
    }
}

/**
* Return the xso object for a built-in XSD Type
*/
function mapXSDTypeToSwagger(xsdType, dict) {
    dictionary.complexityLimitCheck(dict);
    var xso = dictionary.getXSDMapping(xsdType);
    if (!xso) {
        if (xsdType) {
            // Default is to fallback to string
            xso = {
                type: 'string'
            };
        } else {
            // special case for anyType - dont supply a type field at all
            xso = {
                'x-anyType': true,
            };
        }
    }
    return xso;
}

/**
* Determine if the dictionary entry represents a primitive type
*/
function isPrimitiveType(dictEntry, namespaces) {
    let ret = false;
    if (dictEntry && dictEntry.schemaType && dictEntry.schema) {
        if (dictEntry.schemaType == 'simple' && dictEntry.schema.restriction) {
            var restriction = dictEntry.schema.restriction;
            if (restriction['undefined']) {
                if (dictionary.isXSDType(restriction['undefined'].base, namespaces)) {
                    ret = true;
                }
            }
        } else if (dictEntry.schema.simpleContent) {
            var extension = dictEntry.schema.simpleContent.extension;
            if (extension && extension['undefined']) {
                if (dictionary.isXSDType(extension['undefined'].base, namespaces)) {
                    ret = true;
                }
            }
        }
    }
    return ret;
}


// Only merge properties that won't change the core properties of the target
var extensionProperties = {
    enum: true,
    pattern: true,
    format: true,
    default: true,
    minimum: true,
    maximum: true,
    exclusiveMinimum: true,
    exclusiveMaximum: true,
    minLength: true,
    maxLength: true,
    'x-ibm-whiteSpace': true,
    'x-ibm-fractionDigits': true,
    'x-ibm-totalDigits': true,
    description: true
};

/**
* @param source is an XSO object
* @param target is an XSO object that needs to new information from the source
*
* Only certain properties (decorations) are copied over.
*/
function extendXSO(target, source) {
    for (var name in source) {
        if (extensionProperties[name]) {
            target[name] = source[name];
        }
    }
    return target;
}

/**
* Generate a unique property name in the cases where we have a collision (ie. subgroups)
*/
function uniquePropertyName(nsName) {
    // nsName is <name>_<type>_<prefix>  (example: Account_element_s1)
    // return <prefix>%<name> (example s1%Account)
    // The map policy removes (normalizes) the ':' character; thus % is chosen as the separator
    var words = nsName.split('_');
    return words[2] + '%' + words[0];
}

exports.addReference = addReference;
exports.extendXSO = extendXSO;
exports.generateSwaggerDefinitions = generateSwaggerDefinitions;
exports.generateSwaggerXSO = generateSwaggerXSO;
exports.mapXSDTypeToSwagger = mapXSDTypeToSwagger;
exports.UNQUALNS = UNQUALNS;
