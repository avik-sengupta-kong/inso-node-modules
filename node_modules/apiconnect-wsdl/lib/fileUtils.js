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
const EventEmitter = require('events');
const jsyaml = require('js-yaml');
var _ = require('lodash');
const fs = require('fs');
const q = require('q');
const u = require('../lib/utils.js');
const d = require('../lib/domUtils.js');
const http = require('http');
const https = require('https');
const url = require('url');
const iconv = require('iconv-lite');
const yauzl = require('yauzl');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');
const assert = require('assert');
const JSZip = require('jszip');
const R = require('../lib/report.js');
const flattener = require('../lib/flatten.js');

const INTERNAL_WSDL = 'internal.wsdl';

/**
* Return the raw content of the location.
* (note lots of legacy behavior is captured here)
* @param location  This can be url or content
* @param fullPath This is the path to the file if on disk
* @param auth is the auth credentials if if location is a url
* @param context is additional information abbout the use of this method  for error messages.
* @param req for internationaliztion
* @return promise containing { content: content, fileName: <only sef if read from local>}
*/
async function asContent(location, fullPath, auth, context, req) {
    var def = q.defer();
    if (typeof location.substr === 'undefined') {
        // location is raw content
        def.resolve({ content: location });
    } else if (location.substr(0, 7) == 'http://' || location.substr(0, 8) == 'https://') {
        // fetch from URL
        var parsedUrl = url.parse(location);
        var protocol = parsedUrl.protocol.substring(0, parsedUrl.protocol.length - 1);
        var modules = {
            http: http,
            https: https
        };
        var options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.path
        };
        if (auth) {
            options.headers = {
                Authorization: auth
            };
        }
        modules[protocol].get(options, function(response) {
            var strings = [];
            response.on('data', function(data) {
                strings.push(data);
            });
            response.on('end', function() {
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    var content = Buffer.concat(strings);
                    var encoding;
                    var left = content.toString('utf8', 0, 4);
                    if (left == 'PK\u0003\u0004') {
                        // treat as binary
                        encoding = null;
                    } else {
                        encoding = determineEncoding(content, location, req);
                        wsiEncodingCheck(encoding, location, req);
                    }
                    def.resolve({ content: decode(content, encoding), encoding: encoding });
                } else {
                    // Failed to get a remote file
                    def.reject(fileContentError(context,
                      g.http(u.r(req)).f('Failed to retrieve the remote file from location %s. Ensure the remote file is available. ' +
                          'The HTTP Response code is %s.', location, response.statusCode),
                      req));
                }
            });
        }).on('error', function(e) {
            def.reject(fileContentError(context,
              g.http(u.r(req)).f('Failed to retrieve the remote file from location %s. Ensure the remote file is available. The error is (%s).', location, e),
              req));
        });
    } else if (location.substr(0, 6) == 'ftp://') {
        // fetch from FTP
        def.reject(fileContentError(context,
          g.http(u.r(req)).f('Failed to retrieve the remote file from location %s. Ensure the remote file is available. FTP is not supported.', location),
          req));
    } else if (location.substring(0, 5) == '<?xml') {
        // It appears that the location is the file content in memory
        def.resolve({ content: location });
    } else {
        // perform a content sniff to get the read mode correct
        try {
            fs.readFile(fullPath, function(err, rawData) {
                if (err) {
                    // If location is sufficiently large, assume that it is the content and convert to a Buffer
                    if (location.length > 1000) {
                        def.resolve({ content: toBuffer(location, req) });
                    } else {
                        // Return an reasonable message.
                        let resolvedPath = fullPath;
                        try {
                            let path = require('path');
                            resolvedPath = path.resolve(fullPath);
                        } catch (e) {
                            // Accept
                        }

                        try {
                            if (!fs.existsSync(fullPath)) {
                                def.reject(fileContentError(context,
                                  g.http(u.r(req)).f('The local file "%s" does not exist.', resolvedPath), req));
                            } else {
                                def.reject(fileContentError(context,
                                  g.http(u.r(req)).f('The local file "%s" is not accessible. The error is %(s).', resolvedPath, err), req));
                            }
                        } catch (e) {
                            def.reject(fileContentError(context,
                              g.http(u.r(req)).f('The local file "%s" is not accessible. The error is (%s).', resolvedPath, err), req));
                        }
                    }
                } else {
                    let resolvedPath = fullPath;
                    try {
                        let path = require('path');
                        resolvedPath = path.resolve(fullPath);
                    } catch (e) {
                        // Accept
                    }
                    var encoding = 'utf8'; // start with a common default encoding
                    var left = rawData.toString('utf8', 0, 4);
                    if (left == 'PK\u0003\u0004') {
                        // treat as binary
                        encoding = null;
                    } else {
                        encoding = determineEncoding(rawData, fullPath);
                    }
                    def.resolve({ content: decode(rawData, encoding), fileName: resolvedPath, encoding: encoding });
                }
            });
        } catch (e) {
            // If the error is an invalid fullPath, then assume location is the buffer (legacy)
            if (e.toString().indexOf('The argument \'path\' must be a string')) {
                def.resolve({ content: toBuffer(location) });
            } else {
                def.reject(e);
            }
        }
    }
    return def.promise;
}

/**
* Generates an ammended error for getFileContent
*/
function fileContentError(context, error, req) {
    if (context) {
        error = g.http(u.r(req)).f('An error occurred while processing (%s).\nThe error is (%s).\nYou may want to create a zip file containing all of your wsdl/xsd files and use the zip file as the input.', context, error);
    }
    return new Error(error);
}

/**
* Returns the content as an archive object.
* If the flatten option is specified or is specified within the embedded options file, then a flattened archive is returned
*/
async function asArchive(content, req, flatten, fileName, isLegacyStyle) {
    let archive = await asRawArchive(content, req, fileName, isLegacyStyle);
    // If flattening is requested, then convert the archive into an
    // archive with all of the schemas inlined.
    if (flatten !== 'disable' && (archive.options.flatten || flatten)) {
        let flatContent = await flattener.inline(content);
        return await asRawArchive(flatContent, req, fileName, false);
    } else {
        return archive;
    }
}

/**
* Return the content as an Archive Object
*/
async function asRawArchive(content, req, fileName, isLegacyStyle) {
    fileName = fileName || INTERNAL_WSDL;
    if (isArchive(content)) {
        return content;
    } else if (isZip(content)) {
        let archive = {
            style: 'ZIP',
            content: content,
            options: {}
        };
        // If there is an config file, then get the options from it.
        await pipeArchive(archive, req,
          function(fileName, mode, req) {
              return !isConfig(fileName);
          },
          function(fileName, content, req) {
              archive.options = jsyaml.safeLoad(content, 'utf8');
          });
        return archive;
    } else if (!isLegacyStyle) {
        // Put the single file into a zip
        let outZip = new JSZip();
        outZip.file(fileName, content);
        let zipContent = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
        return {
            style: 'ZIP',
            content: zipContent,
            options: {}
        };
    } else {
        let legacyArchive = {
            style: 'LEGACY',
            content: [ {
                fileName: fileName,
                content: toBuffer(content)
            } ],
            options: {}
        };
        return await loadFiles(legacyArchive, req);
    }
}

function isArchive(archive) {
    return ((typeof archive === 'object') && archive.style);
}


/**
* Add fileName with content (buffer) to the specified archive
* @return promise of archive
*/
async function addFileToArchive(archive, fileName, buffer) {
    if (archive.style === 'LEGACY') {
        archive.content.push({ fileName: fileName, content: buffer });
        return archive;
    } else {
        let outZip = await JSZip.loadAsync(archive.content);
        outZip.file(fileName, buffer);
        let zipContent = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
        return {
            style: 'ZIP',
            content: zipContent,
            options: archive.options
        };
    }
}

async function loadFiles(legacyArchive, req, files) {
    if (!files) {
        files = legacyArchive.content;
    }
    let knownFiles = [];
    for (let i = 0; i < legacyArchive.content.length; i++) {
        knownFiles.push(legacyArchive.content[i].fileName);
    }

    // Look for references to new file locations
    let allLocations = [];
    for (let i = 0; i < files.length; i++) {
        // Get the referenced getLocations
        let content = files[i].content;
        let fileName = files[i].fileName;
        let encoding = determineEncoding(content);
        wsiEncodingCheck(encoding, fileName, req);
        let decodedContent = decode(content, encoding);
        let dom = d.loadSafeDOM(decodedContent, req, fileName);
        let locations = d.getLocations(dom, fileName, req).all;
        if (locations.length > 0) {
            allLocations.push(locations);
        }
    }

    // Determine which locations are locations that have not been loaded
    let newLocations = _.pullAll(_.uniq(_.flatten(allLocations)), knownFiles);
    if (newLocations.length === 0) {
        return legacyArchive;
    } else {

        // Load the new locations content
        let newLocationsContent = [];
        for (let i = 0; i < newLocations.length; i++) {
            newLocationsContent.push(await asContent(newLocations[i], newLocations[i], null, null, req));
        }

        // Repeat loadFiles with the new loaded locations
        for (let i = 0; i < newLocationsContent.length; i++) {
            let content = encode(newLocationsContent[i].content, newLocationsContent.encoding);
            let loaded = {
                fileName: newLocations[i],
                content: content
            };
            legacyArchive.content.push(loaded);
        }
        await loadFiles(legacyArchive, req, files);
        return legacyArchive;
    }
}

let ACCEPTABLE = [ 'utf8', 'utf16', 'utf-8', 'utf-16' ];
function wsiEncodingCheck(encoding, fileName, req) {
    if (encoding) {
        encoding = encoding.toLowerCase();
        if (ACCEPTABLE.indexOf(encoding) > -1) {
            // Okay
        } else {
            R.warning(req, g.http(u.r(req)).f('An unanticipated encoding %s was found in file %s. This is a violation of a WS-I Rule (R4003 A DESCRIPTION MUST use either UTF-8 or UTF-16 encoding.).  Processing continues.', encoding, fileName));
        }
    }
}


/**
* @param input zip contents
* @return promise with { files: [], archive  }
*/
function pipeArchive(inputArchive, req, ignore, process) {
    ignore = ignore || defaultIgnore;
    process = process || function() {
        return true;
    };
    if (inputArchive.style === 'ZIP') {
        return pipeArchiveZip(inputArchive, req, ignore, process);
    } else {
        return pipeArchiveLegacy(inputArchive, req, ignore, process);
    }
}

/**
* @param input zip contents
* @return outZipContent
*/
async function pipeArchiveZip(inputArchive, req, ignore, process) {
    let input = inputArchive.content;
    let def = q.defer();
    let data = { files: [] };
    let outZip = new JSZip();
    let fatal = false;
    let readCount = 0;
    let writeCount = 0;
    let READ_LIMIT = 64000000;
    let WRITE_LIMIT = 64000000;
    try {
        if (isZip(input)) {
            input = toBuffer(input);
            yauzl.fromBuffer(input, {
                lazyEntries: true
            }, function(err, zipFile) {
                if (err) {
                    // Fatal error has occurred
                    fatal = true;
                    if (err.message.indexOf('relative path') >= 0) {
                        def.reject(g.http(u.r(req)).Error('The zip file format is incorrect (%s).', err));
                    } else {
                        let detail = g.http(u.r(req)).f('The content may have been uploaded with a wrong encoding (i.e. utf8). ' +
                          'Here are the first 50 base64 characters of the content [%s]. The detailed description is [%s].', input.toString('base64', 0, 50), err);
                        def.reject(g.http(u.r(req)).Error('The zip file format is incorrect (%s). Found while processing %s. A possible is reason is (%s).', err, u.getObjectName(input), detail));
                    }
                } else if (!fatal) {
                    zipFile.on('error', function(err) {
                        fatal = true;
                        def.reject(g.http(u.r(req)).Error('The zip file format is incorrect [%s].', err));
                    });
                    zipFile.on('end', async () => {
                        // Promise is resolved after the zip file is read.
                        let content = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
                        data.archive = {
                            style: 'ZIP',
                            content: content,
                            options: inputArchive.options
                        };
                        def.resolve(data);
                    });
                    zipFile.on('entry', function(entry) {
                        let info = {
                            fileName: entry.fileName,
                            ignore: false,
                            error: null,
                        };
                        try {
                            /* jslint bitwise: true */
                            let mode = entry.externalFileAttributes >>> 16;
                            info.ignore = (ignore) ? ignore(entry.fileName, mode, req) : false;
                        } catch (e) {
                            info.ignore = true;
                            info.error = e;
                        }
                        if (info.ignore) {
                            data.files.push(info);
                            zipFile.readEntry(); // read the next entry
                        } else {
                            // read the file
                            var strings = [];
                            zipFile.openReadStream(entry, function(err, readStream) {
                                if (err) {
                                    fatal = true;
                                    def.reject(err);
                                } else {
                                    readStream.on('data', function(chunk) {
                                        strings.push(chunk);
                                    });
                                    readStream.on('error', function(chunk) {
                                        fatal = true;
                                        def.reject(err);
                                    });
                                    readStream.on('end', function() {
                                        try {
                                            var fileContent = Buffer.concat(strings);
                                            strings.length = 0;
                                            readCount += fileContent.length;
                                            var fileName = entry.fileName;

                                            // If the customer proviced a very, very large zip file containing
                                            // many large xsds that are unreferenced, the zip file processing
                                            // will run out of memory and the designer will hang.
                                            // An error message is better than a hang.
                                            // An alternative is to do mult-passes through the zip.
                                            if (readCount > READ_LIMIT) {
                                                throw g.http(u.r(req)).Error('The zip file contains too many large xsd/wsdl files. ' +
                                                   'Please remove unnecessary xsd/wsdl files and try again.');
                                            }

                                            let pInfo = _processFile(fileName, fileContent, req, process);
                                            info.ignore = pInfo.ignore;
                                            info.error = pInfo.error;
                                            data.files.push(info);

                                            if (!info.ignore) {
                                                writeCount += pInfo.fileContent.length;
                                                if (writeCount > WRITE_LIMIT) {
                                                    throw g.http(u.r(req)).Error('The zip file contains too many large xsd/wsdl files. ' +
                                                       'Please remove unnecessary xsd/wsdl files and try again.');
                                                }
                                                if (pInfo.fileName !== 'XMLSchema.xsd') {
                                                    outZip.file(pInfo.fileName, pInfo.fileContent);
                                                }
                                            }
                                            zipFile.readEntry();
                                        } catch (e) {
                                            // Unhandled or fatal error
                                            fatal = true;
                                            def.reject(e);
                                        }
                                    });
                                }
                            });
                        }
                    });
                    zipFile.readEntry();
                }
            });
        } else {
            def.reject(g.http(u.r(req)).Error('Input is not a zip file.'));
        }
    } catch (err) {
        def.reject(err);
    }
    return def.promise;
}

/**
* Process the file in the archive
* @param fileName is the file being processed
* @param encodedContent is the encoded content (Buffer)
* @process is the callback to process the decoded content
* @return {
    fileName: new file name
    ignore: indicated if file should be ignored
    error: error if an error occured
    fileContent: output encoded content
}
*/
function _processFile(fileName, encodedContent, req, process) {
    let info = {
        fileName: fileName,
        ignore: false,
        error: null,
        fileContent: encodedContent
    };
    try {
        // Issue a better message if no content is detected
        if (encodedContent.length <= 1) {
            if (info.fileName === 'internal.wsdl') {
                throw g.http(u.r(req)).Error('The input WSDL has no content.  Processing cannot continue.  Please correct the file.', info.fileName);
            } else {
                throw g.http(u.r(req)).Error('The file %s has no content.  Processing cannot continue.  Please correct the input.', info.fileName);
            }
        }
        if (process) {
            var encoding = determineEncoding(encodedContent, fileName, req);
            wsiEncodingCheck(encoding, fileName, req);
            let decodedContent = decode(encodedContent, encoding);
            let processInfo = process(fileName, decodedContent.toString(), req, encoding);
            if (processInfo) {
                info.ignore = false;
                info.fileName = processInfo.fileName;
                // If content, then encode
                if (processInfo.content) {
                    info.fileContent = processInfo.content;
                    if (!isUTF8(encoding)) {
                        info.fileContent = encode(info.fileContent, encoding);
                    }
                }
            } else {
                info.ignore = true;
            }
        } else {
            info.ignore = false;
        }
    } catch (e) {
        info.ignore = true;
        info.error = e;
    }
    return info;
}

function pipeArchiveLegacy(inputArchive, req, ignore, process) {
    let def = q.defer();
    let data = {
        files: [],
        archive: {
            style: 'LEGACY',
            content: [],
            options: inputArchive.options
        }
    };
    let list = inputArchive.content;
    for (let i = 0; i < list.length; i++) {
        let fileName = list[i].fileName;
        let fileContent = list[i].content;
        let info = {
            fileName: fileName,
            ignore: false,
            error: null,
        };
        try {
            info.ignore = (ignore) ? ignore(fileName, null) : false;
        } catch (e) {
            info.ignore = true;
            info.error = e;
        }
        if (info.ignore) {
            data.files.push(info);
        } else {
            let pInfo = _processFile(fileName, fileContent, req, process);
            info.ignore = pInfo.ignore;
            info.error = pInfo.error;
            data.files.push(info);
            if (!info.ignore) {
                if (pInfo.fileName !== 'XMLSchema.xsd') {
                    data.archive.content.push({ fileName: pInfo.fileName, fileContent: pInfo.fileContent });
                }
            }
        }
    }
    def.resolve(data);
    return def.promise;
}

/**
* @return true if utf-8
*/
function isUTF8(encoding) {
    return encoding.toLowerCase() === 'utf8' || encoding.toLowerCase() === 'utf-8';
}

function isZip(content) {
    let start = content.toString('utf8', 0, 4).substr(0, 4);
    return (start === 'PK\u0003\u0004');
}

function isMACOSX(fileName) {
    return (/__MACOSX/).test(fileName);
}

function isDirectory(fileName) {
    return (/\/$/).test(fileName);
}

function isWSDL(fileName) {
    return (/\.wsdl$/).test(fileName);
}

function isXSD(fileName) {
    return (/\.xsd$/).test(fileName);
}
function isXML(fileName) {
    return (/\.xml$/).test(fileName);
}
function isConfig(fileName) {
    return fileName === 'apiconnect.yaml';
}

function defaultIgnore(fileName, mode, req) {
    if (isDirectory(fileName)) {
        return true;
    }
    if (isMACOSX(fileName)) {
        return true;
    }
    return !(isXSD(fileName) || isWSDL(fileName) || isXML(fileName) || isConfig(fileName));
}

function isSymbolicLink(mode) {
    /* jslint bitwise: true */
    if (!mode) {
        return false;
    }
    let isFile = (mode & 0o100000);
    let isSymlink = isFile && (mode & 0o020000);
    return isSymlink;
}

function isExecutable(mode) {
    /* jslint bitwise: true */
    if (!mode) {
        return false;
    }
    let isFile = (mode & 0o100000);
    let isExecutableFile = isFile && (mode & 0o000111);
    return isExecutableFile;
}

// Determine the encoding of the content
// The filename is used for error messages.
function determineEncoding(content, filename, req) {
    var ret = null;
    if (Buffer.isBuffer(content)) {
        // check if we have a BOM
        var bomLength = 0;
        var first = content[0];
        if (first == 0xef) {
            if (content[1] == 0xbb && content[2] == 0xbf) {
                ret = 'utf8';
                bomLength = 3;
            }
        } else if (first == 0xfe) {
            if (content[1] == 0xff) {
                if (content[2] == 0x00 && content[3] == 0x00) {
                    ret = 'ucs4';
                    bomLength = 4;
                } else {
                    ret = 'utf16be';
                    bomLength = 2;
                }
            }
        } else if (first == 0xff) {
            if (content[1] == 0xfe) {
                if (content[2] == 0x00 && content[3] == 0x00) {
                    ret = 'ucs4';
                    bomLength = 4;
                } else {
                    ret = 'utf16le';
                    bomLength = 2;
                }
            }
        } else if (first == 0x00 && content[1] == 0x00) {
            if ((content[2] == 0xfe && content[3] == 0xff) || (content[2] == 0xff && content[3] == 0xfe)) {
                ret = 'ucs4';
                bomLength = 4;
            }
        }
        if (bomLength == 0) {
            // no BOM found, try some data inspection to get the encoding
            if (first == 0x00) {
                if (content[1] == 0x00) {
                    if ((content[2] == 0x00 && content[3] == 0x3c) || (content[2] == 0x3c && content[3] == 0x00)) {
                        ret = 'ucs4';
                    }
                } else if (content[1] == 0x3c && content[2] == 0x00) {
                    if (content[3] == 0x00) {
                        ret = 'ucs4';
                    } else if (content[3] == 0x3f) {
                        ret = 'utf16be';
                    }
                }
            } else if (first == 0x3c) {
                if (content[1] == 0x00) {
                    if (content[2] == 0x00 && content[3] == 0x00) {
                        ret = 'ucs4';
                    } else if (content[2] == 0x3f && content[3] == 0x00) {
                        ret = 'utf16le';
                    }
                } else if (content[1] == 0x3f && content[2] == 0x78 && content[3] == 0x6d) {
                    ret = 'utf8';
                }
            } else if (first == 0x4c && content[1] == 0x6f && content[2] == 0xa7 && content[3] == 0x94) {
                ret = 'ebcdic';
            }
        }
        // although we have detected it, some encodings are not supported by iconv so throw here
        if (ret == 'ucs4' || ret == 'ebcdic') {
            throw g.http(u.r(req)).Error('An unsupported character encoding, %s, was found in file %s.', ret, filename);
        }
        // now convert the first part of the buffer using the encoding we already have
        if (content.length > bomLength) {
            var newBuf = new Buffer.alloc(128);
            try {
                content.copy(newBuf, 0, bomLength, 128);
                var xmlSig = decode(newBuf, ret).toString();
                var index = xmlSig.indexOf('<?xml');
                if (index != -1) {
                    var endIndex = xmlSig.indexOf('?>');
                    if (endIndex != -1) {
                        var realSig = xmlSig.substring(index, endIndex);
                        var encIndex = realSig.indexOf('encoding=');
                        if (encIndex != -1) {
                            var quote = realSig.substr(encIndex + 9, 1);
                            var endQuote = realSig.indexOf(quote, encIndex + 10);
                            if (endQuote != -1) {
                                var encoding = realSig.substring(encIndex + 10, endQuote);
                                if (isUTF8(encoding)) {
                                    encoding = 'utf8';
                                }
                                // If have not determined the encoding, then use the xml hint.
                                // Otherwise use the BOM unless an additional encoding of iso-8859-1
                                if (!ret) {
                                    ret = encoding.toLowerCase();
                                } else if (encoding.toLowerCase() === 'iso-8859-1') {
                                    ret = encoding.toLowerCase();
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                var errMsg = g.http(u.r(req)).f('An error (%s) was caught while processing file %s.', e.message, filename);
                throw new Error(errMsg);
            }
        }
    }
    return ret || 'utf8';
}


// Decode the content with the indicated encoding
function decode(content, encoding) {
    if (!encoding) {
        return content;
    } else {
        return iconv.decode(content, encoding);
    }
}

// Encode the content with the indicated encoding
function encode(content, encoding) {
    if (!encoding) {
        return content;
    } else {
        return iconv.encode(content, encoding);
    }
}

function isBase64(str) {
    var re = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
    return re.test(str);
}

// Utility function that converts obj into a Buffer so that
// it can be processed by other functions (i.e. yauzl)
function toBuffer(obj, req) {
    if (!obj) {
        return obj;
    }

    // Try fromBuffer
    try {
        if (typeof obj == 'string') {
            return Buffer.from(obj, isBase64(obj) ? 'base64' : 'binary');
        }
        return Buffer.from(obj);
    } catch (err) {
        throw g.http(u.r(req)).Error('Error trying to convert ' + obj.constructor.name + 'to Buffer: ' + err);
    }
}

function normalizeLocation(location, currLocation, stopAtRoot) {
    var newLocation = currLocation ? currLocation + '/' + location : location;
    var ret = newLocation;
    if (newLocation) {
        var parts = newLocation.split(/[\\/]/);
        if (parts.length > 1) {
            // remove . parts
            for (let i = 0; i < parts.length; i++) {
                let part = parts[i];
                if (part == '.') {
                    parts.splice(i, 1);
                    i = -1;
                }
            } // end for

            for (let i = 0; i < parts.length; i++) {
                let part = parts[i];
                if (part == '..') {
                    if (i > 0) {
                        // remove current .. and prior part
                        parts.splice(i - 1, 2);
                    } else if (stopAtRoot) {
                        // If stop at root...just remove the ..
                        parts.splice(i, 1);
                    } else {
                        // This is the case where the .. extend below the root.
                        // This is not a normal case, but it is needed for migration of old wsdls.
                        // Count consecutive ..
                        let count = 0;
                        for (let j = i; j < parts.length; j++) {
                            if (parts[j] == '..') {
                                count++;
                            } else {
                                break;
                            }
                        }
                        // Remove equal number of subsequent non-..
                        let remove = count;
                        for (let j = i + count; j < (parts.length - 1) && remove > 0; j++) {
                            if (parts[j] != '..') {
                                parts.splice(j, 1);
                                remove--;
                                j--;
                            }
                        }
                        // Remove ..
                        parts.splice(0, count);
                    }
                    i = -1;
                }
            } // end for
            ret = parts.join('/');
        }
    }
    return ret;
}


/**
*  Return text with common chars replaced with escape text.
*/
function escape(text) {
    var map = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' };
    function chr2enc(a) {
        return map[a];
    }
    return text.replace(/[\"&<>]/g, chr2enc);
}


/**
* Utility to replace certain error messages with a more consumable message
*/
function cleanupError(e, req) {
    var ret = e;
    var msg = e.message;
    if (e instanceof assert.AssertionError) {
        if (msg == 'false == true') {
            msg = g.http(u.r(req)).f('Unmatched element nesting was found.');
        }
        ret = new Error(msg);
    } else if (msg == 'Unexpected root element of WSDL or include') {
        msg = g.http(u.r(req)).f('Expected wsdl or xsd content.');
        ret = new Error(msg);
    }
    return ret;
}

/**
* @return last path separator index or -1 if not present or not found
*/
function lastPathSeparator(path) {
    if (!path) {
        return -1;
    }
    let lastSlash = path.lastIndexOf('/');
    let lastBSlash = path.lastIndexOf('\\');
    let colon = path.lastIndexOf(':');
    let i = colon;
    if (lastSlash > i) {
        i = lastSlash;
    }
    if (lastBSlash > i) {
        i = lastBSlash;
    }
    return i;
}

exports.asArchive = asArchive;
exports.asRawArchive = asRawArchive;
exports.addFileToArchive = addFileToArchive;
exports.asContent = asContent;
exports.cleanupError = cleanupError;
exports.encode = encode;
exports.decode = decode;
exports.determineEncoding = determineEncoding;
exports.escape = escape;
exports.INTERNAL_WSDL = INTERNAL_WSDL;
exports.isConfig = isConfig;
exports.isDirectory = isDirectory;
exports.isExecutable = isExecutable;
exports.isMACOSX = isMACOSX;
exports.isSymbolicLink = isSymbolicLink;
exports.isWSDL = isWSDL;
exports.isXSD = isXSD;
exports.isXML = isXML;
exports.isZip = isZip;
exports.lastPathSeparator = lastPathSeparator;
exports.normalizeLocation = normalizeLocation;
exports.pipeArchive = pipeArchive;
exports.toBuffer = toBuffer;
