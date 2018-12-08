const exws = require('../index');

this.ws = new exws.bitmex({});

this.ws.on('open', ()=>{
    console.log('ws open');
    this.ws.subscribeOrderBook('XBTCUSD');
    this.ws.subscribeTrades('XBTCUSD');
    this.ws.subscribeTicker('XBTCUSD');
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