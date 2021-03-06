const {Serialize} = require("eosjs");

const MongoClient = require('mongodb').MongoClient
const { Connection } = require("./connection")


class BlockReceiver {
    /* mode 0 = serial, 1 = parallel */
    constructor({ startBlock = 0, endBlock = 0xffffffff, config, mode = 0 }){
        this.trace_handlers = []
        this.delta_handlers = []
        this.done_handlers = []
        this.progress_handlers = []
        this.fork_handlers = []

        // console.log(config)

        this.config = config
        this.mode = mode

        this.start_block = startBlock
        this.end_block = endBlock
        this.current_block = -1
        this.complete = true

        const mode_str = (mode==0)?'serial':'parallel';

        console.log(`Created BlockReceiver, Start : ${startBlock}, End : ${endBlock}, Mode : ${mode_str}`);

    }

    registerDoneHandler(h){
        this.done_handlers.push(h)
    }

    registerTraceHandler(h){
        this.trace_handlers.push(h)
    }

    registerDeltaHandler(h){
        this.delta_handlers.push(h)
    }

    registerProgressHandler(h){
        this.progress_handlers.push(h)
    }

    registerForkHandler(h){
        this.fork_handlers.push(h)
    }

    status(){
        const start = this.start_block
        const end = this.end_block
        const current = this.current_block

        return {start, end, current}
    }

    async start(){
        this.complete = false

        return new Promise((resolve, reject) => {

            this.connectDb().then((db) => {
                this.db = db

                this.registerDoneHandler(resolve)

                this.connection = new Connection({
                    socketAddress: this.config.eos.wsEndpoint,
                    receivedAbi: (() => {
                        this.requestBlocks()
                    }).bind(this),
                    receivedBlock: this.receivedBlock.bind(this),
                })

            })
        })

        // console.log(this.connection)
    }

    async restart(startBlock, endBlock){
        console.log(`Restarting from ${startBlock} to ${endBlock}`)
        this.start_block = startBlock
        this.end_block = endBlock
        this.complete = false
        this.done_handlers = []

        if (!this.connection){
            this.start()
        }
        else {
            await this.requestBlocks()
        }
    }

    destroy(){
        console.log(`Destroying (TODO)`)
    }

    async connectDb(){
        return
        if (this.config.mongo){
            return new Promise((resolve, reject) => {
                MongoClient.connect(this.config.mongo.url, {useNewUrlParser: true}, ((err, client) => {
                    if (err){
                        reject(err)
                    }
                    else {
                        resolve(client.db(this.config.mongo.dbName))
                    }
                }).bind(this))
            })
        }

    }

    async requestBlocks(){
        try {
            const request_args = {
                irreversibleOnly:false,
                start_block_num: this.start_block,
                end_block_num: this.end_block,
                have_positions:[],
                fetch_block: false,
                fetch_traces: (this.trace_handlers.length > 0),
                fetch_deltas: (this.delta_handlers.length > 0),
            }
            await this.connection.requestBlocks(request_args);
        } catch (e) {
            console.error(`Error requesting blocks ${e.message}`);
            process.exit(1);
        }
    }

    async handleFork(block_num){
        this.fork_handlers.forEach((handler) => {
            handler(block_num)
        })
        // const trace_collection = this.config.mongo.traceCollection
        // const col = this.db.collection(trace_collection)
        // return col.deleteMany({block_num:{$gte:block_num}})
    }

    async receivedBlock(response, block, traces, deltas) {
        if (!response.this_block)
            return;
        let block_num = response.this_block.block_num;

        if ( this.mode === 0 && block_num <= this.current_block ){
            console.log(`Detected fork in serial mode: current:${block_num} <= head:${this.current_block}`)
            await this.handleFork(block_num)
        }

        this.current_block = block_num

        if (!(block_num % 1000) || (this.end_block - this.start_block) < 50){
            console.info(`BlockReceiver : received block ${block_num}`);
            let {start, end, current} = this.status()
            console.info(`Start: ${start}, End: ${end}, Current: ${current}`)

            // this.connection.requestStatus()
            // this.queue.inactiveCount((err, total) => {
            //     console.info("redis queue length " + total)
            // })
        }

        if (deltas && deltas.length){
            this.delta_handlers.forEach(((handler) => {
                if (this.mode === 0){
                    handler.processDelta(block_num, deltas, this.connection.types)
                }
                else {
                    handler.queueDelta(block_num, deltas, this.connection.abi)
                }
            }).bind(this))
        }

        if (traces){
            this.trace_handlers.forEach((handler) => {
                if (this.mode === 0){
                    handler.processTrace(block_num, traces)
                }
                else {
                    handler.queueTrace(block_num, traces)
                }
            })
        }

        if (this.current_block === this.end_block -1 && !this.complete){
            this.complete = true
            this.done_handlers.forEach((handler) => {
                handler()
            })
        }

        this.progress_handlers.forEach((handler) => {
            handler(100 * ((block_num - this.start_block) / this.end_block))
        })

        // const state_col = this.db.collection(this.state_collection)
        // state_col.updateOne({name:'head_block'}, {$set:{block_num}}, {upsert:true})

    } // receivedBlock
}


module.exports = BlockReceiver