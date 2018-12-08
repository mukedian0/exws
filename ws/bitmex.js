'use strict'

const EventEmitter = require('events');
const BitMEXClient = require('bitmex-realtime-api');
const debug = require('debug')('bitmex:ws')
const _ = require('lodash');

const WS_URL = 'wss://www.bitmex.com/realtime'

const isSnapshot = msg => msg[0] && Array.isArray(msg[0]);
/**
 * Communicates with v1 of the Bitmex WebSocket API
 */
class WSv1 extends EventEmitter {
    /**
     * @param {sting} opts.apiKey
     * @param {string} opts.apiSecret
     * @param {string} opts.url - ws connection url
     */
    constructor(opts = { apiKey: '', apiSecret: '', url: WS_URL }) {
        super()

        this._apiKey = opts.apiKey || ''
        this._apiSecret = opts.apiSecret || ''
        this._url = opts.url || WS_URL
        this.option = opts
        this._channelMap = {} // map channel IDs to events

        this.pongTime
    }

    open() {
        debug('ws open', this.option);
        this._ws = new BitMEXClient({
            agent: this.option.agent,
            httpProxy: this.option.httpProxy
        });

        this._ws.on('message', this._onWSMessage.bind(this))
        this._ws.on('open', this._onWSOpen.bind(this))
        this._ws.on('error', this._onWSError.bind(this))
        this._ws.on('close', this._onWSClose.bind(this))
        this._ws.on('initialize', () => console.log('Client initialized, data is flowing.'));
    }

    _processTickerEvent(msg, event) {
        if(!event.pair){
            debug("no pair.");
            return;
        }
        
        let action = msg.action;
        let data = msg.data;
        if(!_.isArray(data) || data.length < 1){
            return;
        }
        if(action == 'init'){
            //要最新的交易数据，第一次全量的不要
            return;
        }
        const ticker = data.map(el => {
            return {
                bid: el.bidPrice,
                ask: el.askPrice,
                lastPrice: undefined,
                volume: undefined,
                high: undefined,
                low: undefined
            }
        })

        this.emit('ticker', event.pair, ticker)
    }

    _processTradeEvent(msg, event) {
        try {
            if(!event.pair){
                debug("no pair.");
                return;
            }
            
            let action = msg.action;
            let data = msg.data;
            if(!_.isArray(data) || data.length < 1){
                return;
            }
            if(action == 'init'){
                //要最新的交易数据，第一次全量的不要
                return;
            }
            const trades = data.map(el => {
                return {
                    seq: el.trdMatchID,
                    price: el.price,
                    amount: el.size,
                    timestamp: el.timestamp,
                    type: el.size == 'Buy' ? 'bid' : 'ask'
                }
            })

            this.emit('trade', event.pair, trades)
        } catch (error) {
            debug(error);
        }
    }

    _processBookEvent(msg, event) {
        try {
            if(!event.pair){
                debug("no pair.");
                return;
            }
            
            let action = msg.action;
            let data = msg.data;
            if(!_.isArray(data) || data.length < 1){
                return;
            }
    
            let orderbook = {asks:[], bids:[]};
            for(let el of data){
                if(el.side == 'Sell'){
                    orderbook.asks.push({
                        price: el.price,
                        amount: action == 'remove' ? 0 : el.size,
                    })
                } else if(el.side == 'Buy'){
                    orderbook.bids.push({
                        price: el.price,
                        amount: action == 'remove' ? 0 : el.size,
                    })
                }
            }
    
            debug(`udpate orderbook: ${JSON.stringify(orderbook)}`);
            this.emit('orderbook', event.pair, orderbook);
        } catch (error) {
            debug(error);
        }
    }

    close() {
        if (this.hb) {
            clearInterval(this.hb);
            this.hb = null;
        }
        this._ws.close()
    }

    _onWSMessage(msgJSON, flags) {
    }

    _onWSOpen() {
        this._channelMap = {}
        this.sendHeartBeat()
        this.monitorConnectStatus();
        this.emit('open')
    }

    _onWSError(error) {
        this.emit('error', error)
    }

    _onWSClose() {
        if (this.hb) {
            clearInterval(this.hb);
            this.hb = null;
        }
        this.emit('close')
    }

    send(msg) {
        debug('Sending ', msg)
        try {
            this._ws.send(JSON.stringify(msg))
        } catch (error) {
            debug('Sending error ', error)
        }
    }

    /**
     * Subscribe to order book updates.
     *
     * @param {string} pair - XBTUSD
     */
    subscribeOrderBook(pair) {
        this._ws.addStream(pair, 'orderBookL2', (data, symbol, tableName) => {
            let event = {channel: tableName, pair: symbol};
            this._processBookEvent(data, event);
        });
    }

    /**
     * Subscribe to trades. 
     *
     * @param {string} pair - XBTUSD
     */
    subscribeTrades(pair) {
        this._ws.addStream(pair, 'trade', (data, symbol, tableName) => {
            let event = {channel: tableName, pair: symbol};
            this._processTradeEvent(data, event);
        });
    }

    /**
     * Subscribe to ticker updates. The ticker is a high level overview of the
     * state of the market. It shows you the current best bid and ask, as well as
     * the last trade price.
     *
     * Event will be emited as `PAIRNAME_ticker`.
     *
     * @param {string} - pair XBTUSD
     */
    subscribeTicker(pair) {
        this._ws.addStream(pair, 'quote', (data, symbol, tableName) => {
            let event = {channel: tableName, pair: symbol};
            this._processTickerEvent(data, event);
        });
    }

    /**
     * Unsubscribe from a channel.
     *
     * @param {number} chanId - ID of the channel received on `subscribed` event
     */
    unsubscribe(chanId) {
        
    }

    sendHeartBeat() {
    }

    monitorConnectStatus() {
    }
}

module.exports = WSv1;