let fs = require('fs')

// Nomor owner = user yang boleh kontrol bot. BUKAN nomor bot yang di-pairing.
// Nomor bot diambil dari env PHONE_NUMBER atau prompt interaktif di main.js.
global.owner = ['62895615063060']
global.mods = []
global.prems = []

global.packname = 'Reze-MD'
global.author = 'Reze-MD'

global.prefix = /^[!#$%+£¢€¥^°=¶∆×÷π√✓©®:;?&.\-]/

global.multiplier = 69

global.maxJadibot = 3 // maksimal session jadibot bersamaan

let file = require.resolve(__filename)
fs.watchFile(file, () => {
  fs.unwatchFile(file)
  console.log("Update 'config.js'")
  delete require.cache[file]
  require(file)
})
