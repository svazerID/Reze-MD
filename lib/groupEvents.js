/**
 * Detektor event grup → notifikasi.
 * Config per grup disimpan di global.db.data.settings (key: `ge:<groupJid>`).
 *
 * Terverifikasi dari type zapo (dist/client/types.d.ts):
 *   - WaGroupEvent: action + authorJid + participants[] + subject + description + code
 *   - WaPictureEvent: action + targetJid + authorJid
 * Catatan: action deskripsi = 'description' (bukan 'desc'), reset link = 'revoke_invite'.
 * Nama di config tetap 'desc'/'revoke' biar sama dengan dokumen & command user.
 */

// action zapo → key config
const ACTION_MAP = {
  add: 'welcome',
  remove: 'goodbye',
  promote: 'promote',
  demote: 'demote',
  description: 'desc',
  subject: 'subject',
  revoke_invite: 'revoke'
}

const EVENTS = ['welcome', 'goodbye', 'promote', 'demote', 'desc', 'subject', 'icon', 'revoke']

// Template default. @user/@admin/@grup/@desc/@link diganti saat render.
const DEFAULT_TEXT = {
  welcome_add: 'Welcome: @admin menambahkan @user ke @grup',
  welcome_link: '@user join ke grup @grup menggunakan link grup',
  goodbye_kick: '@admin mengeluarkan @user dari @grup',
  goodbye_leave: '@user telah keluar dari @grup',
  promote: '@user telah dipromosikan menjadi Admin oleh @admin @grup',
  demote: '@user telah diturunkan dari Admin oleh @admin @grup',
  desc: 'Deskripsi group telah diubah oleh @admin\n\n@desc',
  subject: 'Nama group telah diubah oleh @admin\n\n@grup',
  icon: 'Foto group telah diubah oleh @admin',
  revoke: 'Link group telah diubah oleh @admin\n\n@link'
}

const MAX_TEXT = 500
const DEDUP_TTL_MS = 10_000

// --- Config ---
const cfgKey = jid => `ge:${jid}`

function getConfig(groupJid) {
  let all = global.db.data.settings || (global.db.data.settings = {})
  let cfg = all[cfgKey(groupJid)]
  if (!cfg) {
    cfg = { detect: true, events: {} }
  }
  // lazy create: grup tanpa record = semua ON
  for (let e of EVENTS) {
    if (!cfg.events) cfg.events = {}
    if (!cfg.events[e]) cfg.events[e] = { on: true, text: null }
    else {
      if (typeof cfg.events[e].on !== 'boolean') cfg.events[e].on = true
      if (cfg.events[e].text === undefined) cfg.events[e].text = null
    }
  }
  all[cfgKey(groupJid)] = cfg
  return cfg
}

function shouldSend(groupJid, key) {
  let cfg = getConfig(groupJid)
  return cfg.detect === true && cfg.events[key]?.on === true
}

// --- JID helpers ---
const norm = jid => String(jid || '').split('@')[0].split(':')[0]

// Nomor telepon dari JID (abaikan LID, selalu gunakan JID).
function phoneOf(jid) {
  if (!jid) return null
  let n = norm(jid)
  // Jika JID adalah LID, coba resolve ke JID asli
  if (jid.endsWith('@lid')) {
    const resolvedJid = global.lidCache?.[n]
    return resolvedJid || n // Jika tidak ada di cache, gunakan n (tanpa @lid)
  }
  return n
}

function resolveActor(event) {
  return event.authorJid || null
}

// Prefer a stable PN address for WhatsApp mentions; abaikan LID, gunakan JID
function mentionJid(participant) {
  let jid = participant?.phoneJid || participant?.jid
  // Jika tidak ada phoneJid/jid, coba lidJid dan resolve ke JID
  if (!jid && participant?.lidJid) {
    const lidKey = norm(participant.lidJid)
    jid = global.lidCache?.[lidKey]
    if (jid) jid = `${jid}@s.whatsapp.net`
    else jid = null // Jika tidak bisa resolve, set ke null
  }
  if (!jid) return null
  return jid
}

// --- Dedup ---
const seen = new Map()
function alreadySeen(key, nowMs = Date.now()) {
  for (let [k, t] of seen) if (nowMs - t > DEDUP_TTL_MS) seen.delete(k)
  if (seen.has(key)) return true
  seen.set(key, nowMs)
  return false
}

// --- Metadata cache (TTL pendek, invalidate saat event grup) ---
const metaCache = new Map()
const META_TTL_MS = 30_000
async function groupMeta(conn, groupJid) {
  let hit = metaCache.get(groupJid)
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.data
  let data = await conn.group.queryGroupMetadata(groupJid).catch(() => null)
  if (data) metaCache.set(groupJid, { at: Date.now(), data })
  return data
}
function invalidateMeta(groupJid) {
  metaCache.delete(groupJid)
}

// --- Render ---
function render(template, vars) {
  return String(template)
    .replace(/@user/g, vars.user || 'Seseorang')
    .replace(/@admin/g, vars.admin || 'Seseorang')
    .replace(/@grup/g, vars.grup || '')
    .replace(/@desc/g, vars.desc || '')
    .replace(/@link/g, vars.link || '')
}

// Kumpulkan JID yang perlu di-mention (nomor yang benar-benar muncul di teks).
function collectMentions(text, candidates) {
  let out = []
  for (let jid of candidates) {
    if (!jid) continue
    let p = phoneOf(jid)
    if (p && text.includes('@' + p) && !out.some(existing => phoneOf(existing) === p)) out.push(jid)
  }
  return out
}

// --- Antrean kirim (satu per grup, jeda antar pesan) ---
const queues = new Map()
function enqueue(groupJid, task) {
  let prev = queues.get(groupJid) || Promise.resolve()
  let next = prev.then(() => task().catch(e => console.error('[groupEvent] gagal kirim:', e.message))).then(() => new Promise(r => setTimeout(r, 700)))
  queues.set(groupJid, next)
}

// --- Handler utama ---
async function handleGroupEvent(conn, event) {
  let groupJid = event.groupJid || event.chatJid
  if (!groupJid) return

  invalidateMeta(groupJid)

  let key = ACTION_MAP[event.action]
  if (!key) return // action lain: modify, restrict, announce, ephemeral, dll — di luar scope

  let actor = resolveActor(event)
  let participants = event.participants || []

  // Bot sendiri di-add/dikeluarkan → jangan notif
  let meJid = conn.getCredentials?.()?.meJid || global.conn?.getCredentials?.()?.meJid
  if (meJid && participants.some(p => norm(p.jid) === norm(meJid) || norm(p.lidJid) === norm(meJid) || norm(p.phoneJid) === norm(meJid))) return

  if (!shouldSend(groupJid, key)) return

  // welcome/goodbye: pilih template add vs link, kick vs leave
  let sub = ''
  if (key === 'welcome' || key === 'goodbye') {
    let pelakunyaPeserta = actor && participants.some(p => norm(p.jid) === norm(actor) || norm(p.lidJid) === norm(actor) || norm(p.phoneJid) === norm(actor))
    if (key === 'welcome') sub = (!actor || pelakunyaPeserta) ? '_link' : '_add'
    else sub = (!actor || pelakunyaPeserta) ? '_leave' : '_kick'
  }

  let cfg = getConfig(groupJid)
  let template = cfg.events[key].text || DEFAULT_TEXT[key + sub]
  if (!template) return

  let meta = await groupMeta(conn, groupJid)
  let grupNama = event.subject || meta?.subject || 'grup ini'
  let vars = { admin: actor ? '@' + phoneOf(actor) : null, grup: grupNama }

  // Multi-target → SATU pesan, semua peserta di-mention (§8).
  let targets = participants.length ? participants : [{ jid: actor }]
  let mentionJids = [...new Set(targets.map(mentionJid).filter(Boolean))]
  if (!mentionJids.length && actor) mentionJids = [actor]
  let phones = mentionJids.map(phoneOf).filter(Boolean)

  // dedup per kejadian: key | type | targets | detik
  let dkey = `${groupJid}|${key}|${phones.join(',')}|${event.timestampSeconds || Math.floor(Date.now() / 1000)}`
  if (alreadySeen(dkey)) return

  // @user = semua target; nomor yang tidak known tetap ditandai dengan JID
  vars.user = mentionJids.map(jid => '@' + phoneOf(jid)).join(' ')

  // extra per tipe
  if (key === 'desc') vars.desc = event.description || ''
  if (key === 'subject') vars.grup = event.subject || grupNama
  if (key === 'revoke') {
    let code = event.code
    if (!code) {
      // bot bukan admin → 403; kirim tanpa link
      code = await conn.group.queryInviteCode(groupJid).catch(() => null)
    }
    vars.link = code ? `https://chat.whatsapp.com/${code}` : '(tidak bisa ambil link)'
  }

  let text = render(template, vars).trim()
  if (!text) return
  // Mention metadata harus pakai JID kanonik yang dicantumkan di body.
  let mentions = collectMentions(text, mentionJids.concat(actor ? [mentionJid({ jid: actor })] : []))

  enqueue(groupJid, () => conn.message.send(groupJid, { type: 'text', text }, { mentions }))
}

async function handlePictureEvent(conn, event) {
  let groupJid = event.targetJid
  if (!groupJid?.endsWith('@g.us')) return // hanya foto grup
  if (event.action !== 'set' && event.action !== 'delete') return

  let key = 'icon'
  if (!shouldSend(groupJid, key)) return

  let dkey = `${groupJid}|${key}|${event.action}|${event.timestampSeconds || Math.floor(Date.now() / 1000)}`
  if (alreadySeen(dkey)) return

  let actor = event.authorJid || null
  let cfg = getConfig(groupJid)
  let template = cfg.events[key].text || DEFAULT_TEXT.icon

  let text = render(template, {
    admin: actor ? '@' + phoneOf(actor) : null,
    grup: (await groupMeta(conn, groupJid))?.subject || 'grup ini'
  }).trim()
  let mentions = collectMentions(text, [actor])

  enqueue(groupJid, () => conn.message.send(groupJid, { type: 'text', text }, { mentions }))
}

module.exports = {
  EVENTS, DEFAULT_TEXT, MAX_TEXT,
  getConfig, shouldSend,
  handleGroupEvent, handlePictureEvent,
  render, phoneOf, norm
}
