
'use strict';

//
// This file defines a single function that asynchronously reads a
// JPEG file (or blob) to determine its width and height and find the
// location and size of the embedded preview image, if it has one. If
// it succeeds, it passes an object containing this data to the
// specified callback function. If it fails, it passes an error message
// to the specified error function instead.
//
// This function is capable of parsing and returning EXIF data for a
// JPEG file, but for speed, it ignores all EXIF data except the embedded
// preview image and the image orientation.
//
// This function requires the BlobView utility class
//
function parseJPEGMetadata(file, metadataCallback, metadataError) {
  // This is the object we'll pass to metadataCallback
  var metadata = {};

  // Start off reading a 16kb slice of the JPEG file.
  // Hopefully, this will be all we need and everything else will
  // be synchronous
  BlobView.get(file, 0, Math.min(16 * 1024, file.size), function(data) {
    if (data.byteLength < 2 ||
        data.getUint8(0) !== 0xFF ||
        data.getUint8(1) !== 0xD8) {
      metadataError('Not a JPEG file');
      return;
    }

    // Now start reading JPEG segments
    // getSegment() and segmentHandler() are defined below.
    getSegment(data, 2, segmentHandler);
  });

  // Read the JPEG segment at the specified offset and
  // pass it to the callback function.
  // Offset is relative to the current data offsets.
  // We assume that data has enough data in it that we can
  // can determine the size of the segment, and we guarantee that
  // we read extra bytes so the next call works
  function getSegment(data, offset, callback) {
    try {
      var header = data.getUint8(offset);
      if (header !== 0xFF) {
        metadataError('Malformed JPEG file: bad segment header');
        return;
      }

      var type = data.getUint8(offset + 1);
      var size = data.getUint16(offset + 2) + 2;

      // the absolute position of the segment
      var start = data.sliceOffset + data.viewOffset + offset;
      // If this isn't the last segment in the file, add 4 bytes
      // so we can read the size of the next segment
      var isLast = (start + size >= file.size);
      var length = isLast ? size : size + 4;

      data.getMore(start, length,
                   function(data) {
                     callback(type, size, data, isLast);
                   });
    }
    catch (e) {
      metadataError(e.toString() + '\n' + e.stack);
    }
  }

  // This is a callback function for getNextSegment that handles the
  // various types of segments we expect to see in a jpeg file
  function segmentHandler(type, size, data, isLastSegment) {
    try {
      switch (type) {
      case 0xC0:  // Some actual image data, including image dimensions
      case 0xC1:
      case 0xC2:
      case 0xC3:
        // Get image dimensions
        metadata.height = data.getUint16(5);
        metadata.width = data.getUint16(7);

        // We're done. All the EXIF data will come before this segment
        // So call the callback
        metadataCallback(metadata);
        break;

      case 0xE1:  // APP1 segment. Probably holds EXIF metadata
        parseAPP1(data);
        /* fallthrough */

      default:
        // A segment we don't care about, so just go on and read the next one
        if (isLastSegment) {
          metadataError('unexpected end of JPEG file');
          return;
        }
        getSegment(data, size, segmentHandler);
      }
    }
    catch (e) {
      metadataError(e.toString() + '\n' + e.stack);
    }
  }

  function parseAPP1(data) {
    if (data.getUint32(4, false) === 0x45786966) { // "Exif"
      var exif = parseEXIFData(data);

      if (exif.THUMBNAIL && exif.THUMBNAILLENGTH) {
        var start = data.sliceOffset + data.viewOffset + 10 + exif.THUMBNAIL;
        metadata.preview = {
          start: start,
          end: start + exif.THUMBNAILLENGTH
        };
      }

      // map exif orientation flags for easy transforms
      switch (exif.ORIENTATION) {
        case undefined:
        case 1:
          metadata.rotation = 0;
          metadata.mirrored = false;
          break;
        case 2:
          metadata.rotation = 0;
          metadata.mirrored = true;
          break;
        case 3:
          metadata.rotation = 180;
          metadata.mirrored = false;
          break;
        case 4:
          metadata.rotation = 180;
          metadata.mirrored = true;
          break;
        case 5:
          metadata.rotation = 90;
          metadata.mirrored = true;
          break;
        case 6:
          metadata.rotation = 90;
          metadata.mirrored = false;
          break;
        case 7:
          metadata.rotation = 270;
          metadata.mirrored = true;
          break;
        case 8:
          metadata.rotation = 270;
          metadata.mirrored = false;
          break;
        default:
          throw Error('Unknown Exif code for orientation');
      }
    }
  }

  // Parse an EXIF segment from a JPEG file and return an object
  // of metadata attributes. The argument must be a DataView object
  function parseEXIFData(data) {
    var exif = {};

    var byteorder = data.getUint8(10);
    if (byteorder === 0x4D) {  // big endian
      byteorder = false;
    } else if (byteorder === 0x49) {  // little endian
      byteorder = true;
    } else {
      throw Error('invalid byteorder in EXIF segment');
    }

    if (data.getUint16(12, byteorder) !== 42) { // magic number
      throw Error('bad magic number in EXIF segment');
    }

    var offset = data.getUint32(14, byteorder);

     // This is how we would parse all EXIF metadata more generally.
     // Especially need for iamge orientation
    parseIFD(data, offset + 10, byteorder, exif, true);

    // I'm leaving this code in as a comment in case we need other EXIF
    // data in the future.
    // if (exif.EXIFIFD) {
    //   parseIFD(data, exif.EXIFIFD + 10, byteorder, exif);
    //   delete exif.EXIFIFD;
    // }

    // if (exif.GPSIFD) {
    //   parseIFD(data, exif.GPSIFD + 10, byteorder, exif);
    //   delete exif.GPSIFD;
    // }

    // Instead of a general purpose EXIF parse, we're going to drill
    // down directly to the thumbnail image.
    // We're in IFD0 here. We want the offset of IFD1
    var ifd0entries = data.getUint16(offset + 10, byteorder);
    var ifd1 = data.getUint32(offset + 12 + 12 * ifd0entries, byteorder);
    // If there is an offset for IFD1, parse that
    if (ifd1 !== 0)
      parseIFD(data, ifd1 + 10, byteorder, exif, true);

    return exif;
  }

  function parseIFD(data, offset, byteorder, exif, onlyParseOne) {
    var numentries = data.getUint16(offset, byteorder);
    for (var i = 0; i < numentries; i++) {
      parseEntry(data, offset + 2 + 12 * i, byteorder, exif);
    }

    if (onlyParseOne)
      return;

    var next = data.getUint32(offset + 2 + 12 * numentries, byteorder);
    if (next !== 0 && next < file.size) {
      parseIFD(data, next + 10, byteorder, exif);
    }
  }

  // size, in bytes, of each TIFF data type
  var typesize = [
    0,   // Unused
    1,   // BYTE
    1,   // ASCII
    2,   // SHORT
    4,   // LONG
    8,   // RATIONAL
    1,   // SBYTE
    1,   // UNDEFINED
    2,   // SSHORT
    4,   // SLONG
    8,   // SRATIONAL
    4,   // FLOAT
    8    // DOUBLE
  ];

  // This object maps EXIF tag numbers to their names.
  // Only list the ones we want to bother parsing and returning.
  // All others will be ignored.
  var tagnames = {
    /*
     * We don't currently use any of these EXIF tags for anything.
     *
     *
     '256': 'ImageWidth',
     '257': 'ImageHeight',
     '40962': 'PixelXDimension',
     '40963': 'PixelYDimension',
     '306': 'DateTime',
     '315': 'Artist',
     '33432': 'Copyright',
     '36867': 'DateTimeOriginal',
     '33434': 'ExposureTime',
     '33437': 'FNumber',
     '34850': 'ExposureProgram',
     '34867': 'ISOSpeed',
     '37377': 'ShutterSpeedValue',
     '37378': 'ApertureValue',
     '37379': 'BrightnessValue',
     '37380': 'ExposureBiasValue',
     '37382': 'SubjectDistance',
     '37383': 'MeteringMode',
     '37384': 'LightSource',
     '37385': 'Flash',
     '37386': 'FocalLength',
     '41986': 'ExposureMode',
     '41987': 'WhiteBalance',
     '41991': 'GainControl',
     '41992': 'Contrast',
     '41993': 'Saturation',
     '41994': 'Sharpness',
    // These are special tags that we handle internally
    '34665': 'EXIFIFD',         // Offset of EXIF data
     '34853': 'GPSIFD',          // Offset of GPS data
    */
    '274' : 'ORIENTATION',
    '513': 'THUMBNAIL',         // Offset of thumbnail
    '514': 'THUMBNAILLENGTH'   // Length of thumbnail
  };

  function parseEntry(data, offset, byteorder, exif) {
    var tag = data.getUint16(offset, byteorder);
    var tagname = tagnames[tag];

    // If we don't know about this tag type or already processed it, skip it
    if (!tagname || exif[tagname])
      return;

    var type = data.getUint16(offset + 2, byteorder);
    var count = data.getUint32(offset + 4, byteorder);

    var total = count * typesize[type];
    var valueOffset = total <= 4 ? offset + 8 :
      data.getUint32(offset + 8, byteorder);
    exif[tagname] = parseValue(data, valueOffset, type, count, byteorder);
  }

  function parseValue(data, offset, type, count, byteorder) {
    if (type === 2) { // ASCII string
      var codes = [];
      for (var i = 0; i < count - 1; i++) {
        codes[i] = data.getUint8(offset + i);
      }
      return String.fromCharCode.apply(String, codes);
    } else {
      if (count == 1) {
        return parseOneValue(data, offset, type, byteorder);
      } else {
        var values = [];
        var size = typesize[type];
        for (var i = 0; i < count; i++) {
          values[i] = parseOneValue(data, offset + size * i, type, byteorder);
        }
        return values;
      }
    }
  }

  function parseOneValue(data, offset, type, byteorder) {
    switch (type) {
    case 1: // BYTE
    case 7: // UNDEFINED
      return data.getUint8(offset);
    case 2: // ASCII
      // This case is handed in parseValue
      return null;
    case 3: // SHORT
      return data.getUint16(offset, byteorder);
    case 4: // LONG
      return data.getUint32(offset, byteorder);
    case 5: // RATIONAL
      return data.getUint32(offset, byteorder) /
        data.getUint32(offset + 4, byteorder);
    case 6: // SBYTE
      return data.getInt8(offset);
    case 8: // SSHORT
      return data.getInt16(offset, byteorder);
    case 9: // SLONG
      return data.getInt32(offset, byteorder);
    case 10: // SRATIONAL
      return data.getInt32(offset, byteorder) /
        data.getInt32(offset + 4, byteorder);
    case 11: // FLOAT
      return data.getFloat32(offset, byteorder);
    case 12: // DOUBLE
      return data.getFloat64(offset, byteorder);
    }
    return null;
  }
}

/*
 * Determine the pixel dimensions of an image without actually
 * decoding the image. Passes an object of metadata to the callback
 * function on success or an error message to the error function on
 * failure. The metadata object will include type, width and height
 * properties. Supported image types are GIF, PNG and JPEG. JPEG
 * metadata may also include information about an EXIF preview image.
 *
 * Because of shortcomings in the way Gecko handles images, the
 * Gallery app will crash with an OOM error if it attempts to decode
 * and display an image that is too big. Images require 4 bytes per
 * pixel, so a 10 megapixel photograph requires 40 megabytes of image
 * memory. This function gives the gallery app a way to reject images
 * that are too large.
 *
 * Requires the BlobView class from shared/js/blobview.js and the
 * parseJPEGMetadata() function from shared/js/media/jpeg_metadata_parser.js
 */
function getImageSize(blob, callback, error) {
  BlobView.get(blob, 0, Math.min(1024, blob.size), function(data) {
    // Make sure we are at least 8 bytes long before reading the first 8 bytes
    if (!data || data.byteLength <= 8) {
      error('corrupt image file');
      return;
    }
    var magic = data.getASCIIText(0, 8);
    if (magic.substring(0, 4) === 'GIF8') {
      try {
        callback({
          type: 'gif',
          width: data.getUint16(6, true),
          height: data.getUint16(8, true)
        });
      }
      catch (e) {
        error(e.toString());
      }
    }
    else if (magic.substring(0, 8) === '\x89PNG\r\n\x1A\n') {
      try {
        callback({
          type: 'png',
          width: data.getUint32(16, false),
          height: data.getUint32(20, false)
        });
      }
      catch (e) {
        error(e.toString());
      }
    }
    else if (magic.substring(0, 2) === '\xFF\xD8') {
      parseJPEGMetadata(blob,
                        function(metadata) {
                          metadata.type = 'jpeg';
                          callback(metadata);
                        },
                        error);
    }
    else {
      error('unknown image type');
    }
  });
}

//
// This file defines a single metadataParsers object. The two
// properties of this object are metadata parsing functions for image
// files and video files, intended for use with the MediaDB class.
//
// This file depends on JPEGMetadataParser.js and blobview.js
//
var metadataParser = (function() {
  // If we generate our own thumbnails, aim for this size
  var THUMBNAIL_WIDTH = 60;
  var THUMBNAIL_HEIGHT = 60;

  // Don't try to decode image files of unknown type if bigger than this
  var MAX_UNKNOWN_IMAGE_FILE_SIZE = .5 * 1024 * 1024; // half a megabyte


  // An <img> element for loading images
  var offscreenImage = new Image();

  // The screen size. Preview images must be at least this big
  var sw = window.innerWidth;
  var sh = window.innerHeight;

  // Create a thumbnail size canvas, copy the <img> or <video> into it
  // cropping the edges as needed to make it fit, and then extract the
  // thumbnail image as a blob and pass it to the callback.
  // This utility function is used by both the image and video metadata parsers
  function createThumbnailFromElement(elt, video, rotation,
                                      mirrored, callback)
  {
    // Create a thumbnail image
    var canvas = document.createElement('canvas');
    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = THUMBNAIL_HEIGHT;
    var context = canvas.getContext('2d', { willReadFrequently: true });
    var eltwidth = elt.width;
    var eltheight = elt.height;
    var scalex = canvas.width / eltwidth;
    var scaley = canvas.height / eltheight;

    // Take the larger of the two scales: we crop the image to the thumbnail
    var scale = Math.max(scalex, scaley);

    // Calculate the region of the image that will be copied to the
    // canvas to create the thumbnail
    var w = Math.round(THUMBNAIL_WIDTH / scale);
    var h = Math.round(THUMBNAIL_HEIGHT / scale);
    var x = Math.round((eltwidth - w) / 2);
    var y = Math.round((eltheight - h) / 2);

    var centerX = Math.floor(THUMBNAIL_WIDTH / 2);
    var centerY = Math.floor(THUMBNAIL_HEIGHT / 2);

    // If a orientation is specified, rotate/mirroring the canvas context.
    if (rotation || mirrored) {
      context.save();
      // All transformation are applied to the center of the thumbnail.
      context.translate(centerX, centerY);
    }

    if (mirrored) {
      context.scale(-1, 1);
    }
    if (rotation) {
      switch (rotation) {
      case 90:
        context.rotate(Math.PI / 2);
        break;
      case 180:
        context.rotate(Math.PI);
        break;
      case 270:
        context.rotate(-Math.PI / 2);
        break;
      }
    }

    if (rotation || mirrored) {
      context.translate(-centerX, -centerY);
    }

    // tcl_longxiuping modified for bug 746763 begin.
    try {
      // Draw that region of the image into the canvas, scaling it down
      context.drawImage(elt, x, y, w, h,
        0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    } catch (e) {
      dump('lxp:: File Manager createThumbnailFromElement e ' + e);
    }
    // tcl_longxiuping modified for bug 746763 end.

    // Restore the default rotation so the play arrow comes out correctly
    if (rotation || mirrored) {
      context.restore();
    }

    // If this is a video, superimpose a translucent play button over
    // the captured video frame to distinguish it from a still photo thumbnail
    if (video) {
      // First draw a transparent gray circle
      context.fillStyle = 'rgba(0, 0, 0, .2)';
      context.beginPath();
      context.arc(THUMBNAIL_WIDTH / 2, THUMBNAIL_HEIGHT / 2,
                  THUMBNAIL_HEIGHT / 5, 0, 2 * Math.PI, false);
      context.fill();

      // Now outline the circle in white
      context.strokeStyle = 'rgba(255,255,255,.6)';
      context.lineWidth = 2;
      context.stroke();

      // And add a white play arrow.
      context.beginPath();
      context.fillStyle = 'rgba(255,255,255,.6)';
      // The height of an equilateral triangle is sqrt(3)/2 times the side
      var side = THUMBNAIL_HEIGHT / 5;
      var triangle_height = side * Math.sqrt(3) / 2;
      context.moveTo(THUMBNAIL_WIDTH / 2 + triangle_height * 2 / 3,
                     THUMBNAIL_HEIGHT / 2);
      context.lineTo(THUMBNAIL_WIDTH / 2 - triangle_height / 3,
                     THUMBNAIL_HEIGHT / 2 - side / 2);
      context.lineTo(THUMBNAIL_WIDTH / 2 - triangle_height / 3,
                     THUMBNAIL_HEIGHT / 2 + side / 2);
      context.closePath();
      context.fill();
    }

    canvas.toBlob(function(blob) {
      context = null;
      canvas.width = canvas.height = 0;
      canvas = null;
      callback(blob);
    }, 'image/jpeg');
  }

  //var VIDEOFILE = /DCIM\/\d{3}MZLLA\/VID_\d{4}\.jpg/;

  function metadataParser(file, metadataCallback, metadataError, bigFile) {
    // If the file is a poster image for a video file, then we've want
    // video metadata, not image metadata
    // lxp if (VIDEOFILE.test(file.name)) {
    //  videoMetadataParser(file, metadataCallback, metadataError);
    //  return;
    //}

    // Figure out how big the image is if we can. For JPEG files this
    // calls the JPEG parser and returns the EXIF preview if there is one.
    getImageSize(file, gotImageSize, gotImageSizeError);

    function gotImageSizeError(errmsg) {
      // The image is not a JPEG, PNG or GIF file. We may still be
      // able to decode and display it but we don't know the image
      // size, so we won't even try if the file is too big.
      if (file.size > MAX_UNKNOWN_IMAGE_FILE_SIZE) {
        metadataError('Ignoring large file ' + file.name);
        return;
      }

      // If the file is too small to be an image, ignore it
      if (file.size < 32) {
        metadataError('Ignoring small file ' + file.name);
        return;
      }

      // If the error message is anything other than unknown image type
      // it means we've got a corrupt image file, or the image metdata parser
      // can't handle the file for some reason. Log a warning but keep going
      // in case the image is good and the metadata parser is buggy.
      if (errmsg !== 'unknown image type') {
        console.warn('getImageSize', errmsg, file.name);
      }

      // If it is not too big create a preview and thumbnail.
      createThumbnailAndPreview(file,
                                metadataCallback,
                                metadataError,
                                false,
                                bigFile,
                                {});
    }

    function gotImageSize(metadata) {
      // If the image is too big, reject it now so we don't have
      // memory trouble later.
      // CONFIG_MAX_IMAGE_PIXEL_SIZE is maximum image resolution we can handle.
      // It's from config.js which is generated in build time, 5 megapixels by
      // default (see build/application-data.js). It should be synced with
      // Camera app and update carefully.
      if (metadata.width * metadata.height > CONFIG_MAX_IMAGE_PIXEL_SIZE) {
        metadataError('Ignoring high-resolution image ' + file.name);
        return;
      }

      // If the image is lower resolution but with large file size, like
      // animated GIF, we should not decode it.
      if ((file.type === 'image/gif' || file.name.endsWith('.gif')) &&
          file.size > CONFIG_MAX_GIF_IMAGE_FILE_SIZE) {
        metadataError('Ignoring acceptable resolution but large gif file ' +
                      file.name);
        return;
      }

      // tcl_longxiuping add for bug 733674 begin
      // For low memory device
      // If the image is large resolution but with small file size, like
      // animated GIF, we should not decode it.
      if ((file.type === 'image/gif' || file.name.endsWith('.gif')) &&
          metadata.width * metadata.height > CONFIG_MAX_GIF_IMAGE_PIXEL_SIZE) {
        metadataError('Ignoring acceptable size but large resolution ' +
          'gif file ' + file.name);
        return;
      }

      // If the file included a preview image, see if it is big enough
      if (metadata.preview) {
        // Create a blob that is just the preview image
        var previewblob = file.slice(metadata.preview.start,
                                     metadata.preview.end,
                                     'image/jpeg');

        // Check to see if the preview is big enough to use in MediaFrame
        parseJPEGMetadata(previewblob, previewsuccess, previewerror);
      }
      else {
        // If there wasn't a preview image, then generate a preview and
        // thumbnail from the full size image.
        useFullsizeImage();
      }

      function previewerror(msg) {
        // The preview isn't a valid jpeg file, so use the full image to
        // create a preview and a thumbnail
        console.error(msg);
        useFullsizeImage();
      }

      function useFullsizeImage() {
        // Since a number of different cases use the same fallback method
        // define it in one place for easier code flow.
                                      createThumbnailAndPreview(file,
                                                               metadataCallback,
                                  metadataError,
                                  false,
                                  bigFile,
                                  metadata);
      }

      function previewsuccess(previewmetadata) {
        // Size of the preview image
        var pw = previewmetadata.width;
        var ph = previewmetadata.height;
        // optional configuration specifying minimum size
        var mw = CONFIG_REQUIRED_EXIF_PREVIEW_WIDTH;
        var mh = CONFIG_REQUIRED_EXIF_PREVIEW_HEIGHT;

        var bigenough;

        // If config.js specifies a minimum required preview size,
        // then this preview is big enough if both dimensions are
        // larger than that configured minimum. Otherwise, the preview
        // is big enough if at least one dimension is >= the screen
        // size in both portait and landscape mode.
        if (mw && mh) {
          bigenough =
            Math.max(pw, ph) >= Math.max(mw, mh) &&
            Math.min(pw, ph) >= Math.min(mw, mh);
        }
        else {
          bigenough = (pw >= sw || ph >= sh) && (pw >= sh || ph >= sw);
        }

        // If the preview is big enough, use it to create a thumbnail.
        if (bigenough) {
          metadata.preview.width = pw;
          metadata.preview.height = ph;
          // The 4th argument true means don't actually create a preview
          createThumbnailAndPreview(previewblob,
                                    metadataCallback,
                                    previewerror,
                                    true,
                                    bigFile,
                                    metadata);
        } else {
          // Preview isn't big enough so get one the hard way
          useFullsizeImage();
        }
      }
    }
  }

  // Load an image from a file into an <img> tag, and then use that
  // to get its dimensions and create a thumbnail.  Store these values in
  // a metadata object, and pass the object to the callback function.
  // If anything goes wrong, pass an error message to the error function.
  // If it is a large image, create and save a preview for it as well.
  function createThumbnailAndPreview(file, callback, error, nopreview,
                                     bigFile, metadata) {
    var url = URL.createObjectURL(file);
    offscreenImage.src = url;

    offscreenImage.onerror = function() {
      URL.revokeObjectURL(url);
      offscreenImage.src = '';
      error('createThumbnailAndPreview: Image failed to load');
    };

    offscreenImage.onload = function() {
      URL.revokeObjectURL(url);

      var iw = offscreenImage.width;
      var ih = offscreenImage.height;

      // Don't overwrite the metadata in the case we read a previewblob.
      if (!nopreview) {
        metadata.width = iw;
        metadata.height = ih;
      }

      // If this is a big image, then decoding it takes a lot of memory.
      // We set this flag to prevent the user from zooming in on other
      // images at the same time because that also takes a lot of memory
      // and we don't want to crash with an OOM. If we find one big image
      // we assume that there may be others, so the flag remains set until
      // the current scan is complete.
      //
      // XXX: When bug 854795 is fixed, we'll be able to create previews
      // for large images without using so much memory, and we can remove
      // this flag then.
      if (iw * ih > 2 * 1024 * 1024 && bigFile)
        bigFile();

      // If the image was already thumbnail size, it is its own thumbnail
      // and it does not need a preview
      if (metadata.width <= THUMBNAIL_WIDTH &&
          metadata.height <= THUMBNAIL_HEIGHT) {
        offscreenImage.src = '';
        metadata.thumbnail = file;
        callback(metadata);
      }
      else {
        createThumbnailFromElement(
          offscreenImage,
          false,
          metadata.rotation || 0,
          metadata.mirrored || false,
          gotThumbnail);
      }

      function gotThumbnail(thumbnail) {
        metadata.thumbnail = thumbnail;
        // If no preview was requested, or if if the image was less
        // than half a megapixel then it does not need a preview
        // image, and we can call the callback right away
        if (nopreview || metadata.width * metadata.height < 512 * 1024) {
          offscreenImage.src = '';
          callback(metadata);
        }
        else {
          // Otherwise, this was a big image and we need to create a
          // preview for it so we can avoid decoding the full size
          // image again when possible
          createAndSavePreview();
        }
      }

      function createAndSavePreview() {
        // Figure out the preview size.
        // Make sure the size is big enough for both landscape and portrait
        var scale = Math.max(Math.min(sw / iw, sh / ih, 1),
                             Math.min(sh / iw, sw / ih, 1));
        var pw = iw * scale, ph = ih * scale; // preview width and height;

        // Create the preview in a canvas
        var canvas = document.createElement('canvas');
        canvas.width = pw;
        canvas.height = ph;
        var context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(offscreenImage, 0, 0, iw, ih, 0, 0, pw, ph);
        canvas.toBlob(function(blob) {
          offscreenImage.src = '';
          canvas.width = canvas.height = 0;
          savePreview(blob);
        }, 'image/jpeg');

        function savePreview(previewblob) {
          var storage = navigator.getDeviceStorage('pictures');
          var filename;
          if (file.name[0] === '/') {
            // We expect file.name to be a fully qualified name (perhaps
            // something like /sdcard/DCIM/100MZLLA/IMG_0001.jpg).
            var slashIndex = file.name.indexOf('/', 1);
            if (slashIndex < 0) {
              error("savePreview: Bad filename: '" + file.name + "'");
              return;
            }
            filename =
              file.name.substring(0, slashIndex) + // storageName (i.e. /sdcard)
              '/.filemanager/previews' +
              file.name.substring(slashIndex); // rest of path (i,e, /DCIM/...)
          } else {
            // On non-composite storage areas (e.g. desktop), file.name will be
            // a relative path.
            filename = '.filemanager/previews/' + file.name;
          }

          // Add a '.jpeg' extension to all preview files. This is necessary
          // because all previews get saved as jpegs even if the original
          // image is not a jpeg. But DeviceStorage uses the filename extension
          // to determine the file type.
          filename += '.jpeg';

          // Delete any existing preview by this name
          var delreq = storage.delete(filename);
          delreq.onsuccess = delreq.onerror = save;

          function save() {
            var savereq = storage.addNamed(previewblob, filename);
            savereq.onerror = function() {
              console.error('Could not save preview image', filename);
            };

            // Don't actually wait for the save to complete. Go start
            // scanning the next one.
            metadata.preview = {
              filename: filename,
              width: pw,
              height: ph
            };
            callback(metadata);
          }
        }
      }
    };
  }

  /* lxp
  function videoMetadataParser(file, metadataCallback, errorCallback) {
    var metadata = {};
    var videofilename = file.name.replace('.jpg', '.3gp');
    metadata.video = videofilename;

    var getreq = videostorage.get(videofilename);
    getreq.onerror = function() {
      errorCallback('cannot get video file: ' + videofilename);
    };
    getreq.onsuccess = function() {
      var videofile = getreq.result;
      getVideoRotation(videofile, function(rotation) {
        if (typeof rotation === 'number') {
          metadata.rotation = rotation;
          getVideoThumbnailAndSize();
        }
        else if (typeof rotation === 'string') {
          errorCallback('Video rotation:', rotation);
        }
      });
    };

    function getVideoThumbnailAndSize() {
      var url = URL.createObjectURL(file);
      offscreenImage.src = url;

      offscreenImage.onerror = function() {
        URL.revokeObjectURL(url);
        offscreenImage.src = '';
        errorCallback('getVideoThumanailAndSize: Image failed to load');
      };

      offscreenImage.onload = function() {
        URL.revokeObjectURL(url);

        // We store the unrotated size of the poster image, which we
        // require to have the same size and rotation as the video
        metadata.width = offscreenImage.width;
        metadata.height = offscreenImage.height;

        createThumbnailFromElement(offscreenImage,
                                   true,
                                   metadata.rotation,
                                   false,
                                   function(thumbnail) {
                                     metadata.thumbnail = thumbnail;
                                     offscreenImage.src = '';
                                     metadataCallback(metadata);
                                   });
      };
    }
  }
*/
  return metadataParser;
}());
