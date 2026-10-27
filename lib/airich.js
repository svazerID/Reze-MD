/**
 * Helper pesan AIRich (richResponseMessage) untuk zapo-js.
 * Bentuk yang dikirim: { botForwardedMessage: { message: { richResponseMessage } } }
 * Render tiap tipe tergantung client WhatsApp; text/code/table/grid image paling aman.
 */

const { randomUUID } = require('crypto')

const T = {
  GRID_IMAGE: 1,
  TEXT: 2,
  INLINE_IMAGE: 3,
  TABLE: 4,
  CODE: 5,
  DYNAMIC: 6,
  MAP: 7,
  LATEX: 8,
  CONTENT_ITEMS: 9
}

// highlightType untuk blok kode
const CODE = {
  DEFAULT: 0,
  KEYWORD: 1,
  METHOD: 2,
  STRING: 3,
  NUMBER: 4,
  COMMENT: 5
}

function text(messageText) {
  return { messageType: T.TEXT, messageText: String(messageText ?? '') }
}

// input: string (satu blok plain) atau array { highlightType, codeContent }
function code(input, codeLanguage = 'text') {
  let codeBlocks = Array.isArray(input)
    ? input.map(b => ({
      highlightType: b.highlightType ?? CODE.DEFAULT,
      codeContent: String(b.codeContent ?? '')
    }))
    : [{ highlightType: CODE.DEFAULT, codeContent: String(input ?? '') }]

  return { messageType: T.CODE, codeMetadata: { codeLanguage, codeBlocks } }
}

function table(rows, title) {
  return {
    messageType: T.TABLE,
    tableMetadata: {
      ...(title ? { title } : {}),
      rows: (rows || []).map(r => Array.isArray(r)
        ? { items: r, isHeading: false }
        : { items: r.items || [], isHeading: !!r.isHeading })
    }
  }
}

// alignment: 0 leading, 1 trailing, 2 center
function image(url, { text: imageText, tapLinkUrl, alignment } = {}) {
  let metadata = { imageUrl: toImageUrl(url) }
  if (imageText) metadata.imageText = imageText
  if (tapLinkUrl) metadata.tapLinkUrl = tapLinkUrl
  if (alignment != null) metadata.alignment = alignment
  return { messageType: T.INLINE_IMAGE, imageMetadata: metadata }
}

function gridImage(urls, { gridImageUrl } = {}) {
  let metadata = { imageUrls: (urls || []).map(toImageUrl) }
  if (gridImageUrl) metadata.gridImageUrl = toImageUrl(gridImageUrl)
  return { messageType: T.GRID_IMAGE, gridImageMetadata: metadata }
}

// type: 1 image, 2 gif
function dynamic(url, { type = 1, version, loopCount } = {}) {
  let metadata = { type, url }
  if (version != null) metadata.version = version
  if (loopCount != null) metadata.loopCount = loopCount
  return { messageType: T.DYNAMIC, dynamicMetadata: metadata }
}

function map({ centerLatitude, centerLongitude, latitudeDelta, longitudeDelta, annotations = [], showInfoList } = {}) {
  let metadata = { annotations: (annotations || []).map(a => ({ ...a })) }
  if (centerLatitude != null) metadata.centerLatitude = centerLatitude
  if (centerLongitude != null) metadata.centerLongitude = centerLongitude
  if (latitudeDelta != null) metadata.latitudeDelta = latitudeDelta
  if (longitudeDelta != null) metadata.longitudeDelta = longitudeDelta
  if (showInfoList != null) metadata.showInfoList = showInfoList
  return { messageType: T.MAP, mapMetadata: metadata }
}

function latexExpression(latexExpression, url, opts = {}) {
  let expression = { latexExpression, url }
  for (let key of ['width', 'height', 'fontHeight', 'imageTopPadding', 'imageLeadingPadding', 'imageBottomPadding', 'imageTrailingPadding']) {
    if (opts[key] != null) expression[key] = opts[key]
  }
  return expression
}

function latex(tex, expressions = []) {
  return {
    messageType: T.LATEX,
    latexMetadata: { text: String(tex ?? ''), expressions }
  }
}

// contentType: 0 default, 1 carousel
function contentItems(items, contentType = 1) {
  return {
    messageType: T.CONTENT_ITEMS,
    contentItemsMetadata: {
      contentType,
      itemsMetadata: (items || []).map(it => it.reelItem ? { reelItem: { ...it.reelItem } } : { reelItem: { ...it } })
    }
  }
}

function toImageUrl(url) {
  if (typeof url === 'string') {
    return { imagePreviewUrl: url, imageHighResUrl: url, sourceUrl: url }
  }
  return { ...url }
}

function toUnifiedResponse(value) {
  if (value == null) return null
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { data: value }
  if (typeof value === 'object' && value.data) return value
  return { data: Buffer.from(JSON.stringify(value)) }
}

// Nama tipe blok kode untuk GenAICodeUXPrimitive (proto pakai angka).
const CODE_TYPE = ['DEFAULT', 'KEYWORD', 'METHOD', 'STR', 'NUMBER', 'COMMENT']

// Susun unifiedResponse dari submessage text/code saja. Tipe lain belum dipetakan,
// jadi kembalikan null supaya client memakai submessages apa adanya.
function unifiedFrom(submessages) {
  let sections = []
  for (let sub of submessages || []) {
    if (sub.messageType === T.TEXT) {
      sections.push({
        __typename: 'GenAIUnifiedResponseSection',
        view_model: {
          primitive: { text: sub.messageText, __typename: 'GenAIMarkdownTextUXPrimitive' },
          __typename: 'GenAISingleLayoutViewModel'
        }
      })
    } else if (sub.messageType === T.CODE) {
      sections.push({
        view_model: {
          primitive: {
            language: sub.codeMetadata?.codeLanguage || 'text',
            code_blocks: (sub.codeMetadata?.codeBlocks || []).map(b => ({
              content: b.codeContent,
              type: CODE_TYPE[b.highlightType] || 'DEFAULT'
            })),
            __typename: 'GenAICodeUXPrimitive'
          },
          __typename: 'GenAISingleLayoutViewModel'
        }
      })
    } else {
      return null
    }
  }
  return sections.length ? { response_id: randomUUID(), sections } : null
}

function build(submessages, { messageType = 1, unifiedResponse, contextInfo } = {}) {
  let richResponseMessage = { messageType, submessages }
  let unified = toUnifiedResponse(unifiedResponse) || toUnifiedResponse(unifiedFrom(submessages))
  if (unified) richResponseMessage.unifiedResponse = unified
  if (contextInfo) richResponseMessage.contextInfo = contextInfo
  return { botForwardedMessage: { message: { richResponseMessage } } }
}

async function send(conn, chat, submessages, { quote, ...opts } = {}) {
  return conn.message.send(chat, build(submessages, opts), quote ? { quote } : {})
}

module.exports = {
  T,
  CODE,
  text,
  code,
  table,
  image,
  gridImage,
  dynamic,
  map,
  latex,
  latexExpression,
  contentItems,
  build,
  send
}
