
const version = '1.0.0'

const exchanges = {
    'bitfinex':                 require ('./ws/bitfinex.js'),
    'bitmex':                   require ('./ws/bitmex.js'),
    'gateio':                   require ('./ws/gateio.js'),
    'huobipro':                 require ('./ws/huobipro.js'),
    'okex2':                     require ('./ws/okex.js'),
    'okex':                     require ('./ws/okex3.js'),
    'zb':                       require ('./ws/zb.js'),
}

//-----------------------------------------------------------------------------

module.exports = Object.assign ({ version, exchanges: Object.keys (exchanges) }, exchanges)

//-----------------------------------------------------------------------------