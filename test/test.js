const exws = require('../index');
const HttpsProxyAgent = require('https-proxy-agent')

let httpAgent = new HttpsProxyAgent('http://127.0.0.1:1087');
this.ws = new exws.bitfinex({agent: httpAgent});

this.ws.on('open', ()=>{
    console.log('ws open');
    this.ws.subscribeOrderBook('btcusd');
    //this.ws.subscribeTrades('btcusd');
    //this.ws.subscribeTicker('btcusd');
})
this.ws.on('close', ()=>{console.log('ws close')})
this.ws.on('error', (error)=>{console.log('ws error', error)})

this.ws.on('orderbook', (symbol, depth)=>{
    console.log(`${symbol} depth======`, depth);
})


this.ws.on('trade', (symbol, trades)=>{
    console.log(`${symbol} trades******`, trades);
})


this.ws.on('ticker', (symbol, ticker)=>{
    console.log(`${symbol} ticker@@@@@@@`, ticker);
})

this.ws.open();