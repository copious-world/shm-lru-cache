const shm = require('shm-typed-lru')
const { XXHash32 } = require('xxhash-addon')
const ftok = require('ftok')
const path = rquire('path')

const MAX_EVICTS = 10
const MIN_DELTA = 1000*60*60   // millisecs
const MAX_FAUX_HASH = 100000
const INTER_PROC_DESCRIPTOR_WORDS = 8
//


const WORD_SIZE = 4
const LONG_WORD_SIZE = 8
const HH_HEADER_SIZE = 64

//
const PID_INDEX = 0
const WRITE_FLAG_INDEX = 1
const INFO_INDEX_LRU = 2
const INFO_INDEX_HH = 3
const NUM_INFO_FIELDS = 4

const LRU_HEADER = 64

function check_buffer_type(buf) {
    return true
}

function isArray(arr) {
    if ( (typeof arr === 'object' && arr.length )) return(true)
    return(false)
}


var g_app_seed = 0
var g_hasher32 = null

function default_hash(data) {
    if ( !(g_hasher32) ) return(0)
    hasher32.update(data)
    let h = hasher32.digest()
    let hh = h.readUInt32BE(0)
    hasher32.reset()
    //
    return hh
}

class ReaderWriter {
    constructor() {
        this.reading = true
        this.writing = true
        this.asset_lock = 0
        this.com_buffer = []
        this.nprocs = 0
        this.proc_index = -1
        this.pid = process.pid
        this.resolver = null
        //
        process.on('SIGUSR2',() => {
            this.asset_lock++
            if ( this.asset_lock > this.nprocs ) this.asset_lock = this.nprocs
        })

        process.on('SIGPIPE',() => {
            if ( this.asset_lock > 0 ) this.asset_lock--
            if ( (this.asset_lock == 0) &&  (this.resolver != null) ) {
                this.resolver(true)
            }
        })
    }
    
    check_asset() {
        return new Promise((resolve,reject) => {
            if ( !(this.asset_lock) ) resolve(true)
            this.resolver = resolve
        })
    }

    async writing() {
        this.writing = await this.check_asset()
        this.resolver = null
    }

    async reading() {
        this.reading = await this.check_asset()
        this.resolver = null
    }

    sig_lock_writing() {
        if ( this.proc_index >= 0 && this.com_buffer.length ) {
            let n = this.nprocs
            for ( let i = 0; i < n; i++ ) {
                let ii = NUM_INFO_FIELDS*n
                let pid = this.com_buffer[ii + PID_INDEX]
                process.kill(pid,'SIGUSR2')
            }
        }
        return true
    }

    async lock_writing() {
        await this.writing()
        this.sig_lock_writing()
        await this.writing()
    }

    unlock_writing() {
        if ( this.proc_index >= 0 && this.com_buffer.length ) {
            let n = this.nprocs
            for ( let i = 0; i < n; i++ ) {
                let ii = NUM_INFO_FIELDS*n
                let pid = this.com_buffer[ii + PID_INDEX]
                if ( this.pid != pid ) {
                    process.kill(pid,'SIGPIPE')
                }
            }
        }
    }
    //
}

  // master_of_cerimonies -- a path
  // proc_names -- the list of js file names that will be attaching to the regions.
  // initializer -- true if master of ceromonies

class ShmLRUCache extends ReaderWriter {

    constructor(conf) {
        let common_path = conf.master_of_cerimonies
        this.shm_com_key = ftok(common_path)
        this.hashe = default_hash
        //
        this.init_shm_communicator(conf)
        this.init_cach(conf)
    }
    
    init_shm_communicator(conf) {
        //
        let sz = INTER_PROC_DESCRIPTOR_WORDS
        let proc_count = conf.proc_names.length
        this.initalizer = conf.initializer
        if ( this.initializer ) {
            this.com_buffer = shm.create(proc_count*sz,'Uint32Array',this.shm_com_key)
        } else {
            this.com_buffer = shm.get(this.shm_com_key,'Uint32Array')
        }
        //
        let myname = path.basename(proces.argv[1],'.js')
        this.proc_index = conf.proc_names.indexOf(myname) + 1
        this.nprocs = conf.proc_names.length
        let pid = this.pid
        let p_offset = NUM_INFO_FIELDS*(this.proc_index)
        this.com_buffer[p_offset + PID_INDEX] = pid
        this.com_buffer[p_offset + WRITE_FLAG_INDEX] = 0
        this.com_buffer[p_offset + INFO_INDEX_LRU] = 0  //??
        this.com_buffer[p_offset + INFO_INDEX_HH] = 0  //??
        //
    }

    init_cache(conf) {
        this.record_size = conf.record_size
        this.count = conf.el_count
        //
        if ( this.initializer ) {
            let sz = this.count*(this.record_size + LRU_HEADER)
            this.lru_buffer =  shm.create(sz);
            this.lru_key = this.lru_buffer.key
            this.count = shm.initLRU(this.lru_buffer.key,this.record_size,sz,true)
            //
            sz = (2*this.count*(WORD_SIZE + LONG_WORD_SIZE) + HH_HEADER_SIZE)
            this.hh_bufer = shm.create(sz); 
            this.hh_key = this.hh_bufer.key
            shm.initHopScotch(this.hh_key,this.lru_key,true,(cache_count*2))
            //
            this.com_buffer[INFO_INDEX_LRU] = this.lru_key
            this.com_buffer[INFO_INDEX_HH] = this.hh_key
        } else {
            this.lru_key = this.com_buffer[INFO_INDEX_LRU]
            this.hh_key = this.com_buffer[INFO_INDEX_HH]
            //
            this.lru_buffer = shm.get(lru_key); //
            let sz = this.count*(this.record_size + LRU_HEADER)
            this.count = shm.initLRU(lru_key,this.record_size,sz,false)
            this.hh_bufer = shm.get(hh_key);
            shm.initHopScotch(hh_key,lru_key,false,this.count)
            //
        }
    }

    // ---- ---- ---- ---- ---- ---- ---- ---- ----

    hash(value) {
        return( this.hasher(value) )
    }
    
    async set(hash_augmented,value) {
        if ( !(value.length) ) return(-1)
        if ( value.length > this.record_size ) return(-1)
        let pair = hash_augmented.split('-')
		let hash = parseInt(pair[0])
		let index = parseInt(pair[1])
        //
        this.lock_writing()
        shm.set(this.lru_key,value,hash,index)
        this.unlock_writing()
    }

    async get(hash_augmented) {
        let pair = hash_augmented.split('-')
		let hash = parseInt(pair[0])
        let index = parseInt(pair[1])
        await this.reading()
        let value = shm.get_el_hash(this.lru_key,hash,index)
        return(value)
    }

    async del(hash_augmented) {
        let pair = hash_augmented.split('-')
		let hash = parseInt(pair[0])
        let index = parseInt(pair[1])
        await this.writing()
        return(shm.del_key(this.lru_key,hash,index))
    }

}



module.exports = ShmLRUCache