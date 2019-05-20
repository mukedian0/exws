const exws = require('../index');

this.ws = new exws.okex({});

this.ws.on('open', ()=>{
    console.log('ws open');
    this.ws.subscribeOrderBook('btc_usdt');
    this.ws.subscribeTrades('btc_usdt');
    this.ws.subscribeTicker('btc_usdt');
})
this.ws.on('close', ()=>{console.log('ws close')})
this.ws.on('error', (error)=>{console.log('ws error')})

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