const shm = require('shm-typed-lru')
const { XXHash32 } = require('xxhash-addon')
const ftok = require('ftok')


const MAX_EVICTS = 10
const MIN_DELTA = 1000*60*60   // millisecs
const MAX_FAUX_HASH = 100000
const INTER_PROC_DESCRIPTOR_WORDS = 8
const DEFAULT_RESIDENCY_TIMEOUT = MIN_DELTA
//

const SUPER_HEADER = 256
const MAX_LOCK_ATTEMPTS = 3

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


var g_app_seed = 0
var g_hasher32 = null

var g_buf_enc = new TextEncoder()

function default_hash(data) {
    if ( !(g_hasher32) ) return(0)
    try {
        if ( typeof data === "string" ) {
            let buf = g_buf_enc.encode(data)
            data = buf
        }
        g_hasher32.update(data)
        let h = g_hasher32.digest()
        let hh = h.readUInt32BE(0)
        g_hasher32.reset()
        return hh            
    } catch (e) {
        console.log(e)
    }
    return 0
}


function init_default(seed) {
    g_app_seed = parseInt(seed,16);
    g_hasher32 = new XXHash32(g_app_seed);
    return default_hash
}




class ReaderWriter {

    //
    constructor(conf) {
        let common_path = conf.master_of_ceremonies
        if ( common_path === undefined ) {
            common_path = conf.token_path
        }
        this.shm_com_key = ftok(common_path)
        if ( this.shm_com_key < 0 ) {
            common_path = __dirname
            //console.log(common_path)
            this.shm_com_key = ftok(common_path)
        }
        //
        this.asset_lock = false
        this.com_buffer = []
        this.nprocs = 0
        this.proc_index = -1
        this.pid = process.pid
        this.resolver = null
    }
    
    // ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ----
    try_again(resolve,reject,count) {
        count++
        // try again at least once before stalling on a lock
        setImmediate(() => { 
            let result = shm.try_lock(this.shm_com_key)
            if ( result === true ) {
                resolve(true)
            } else if ( result === false ) {
                if ( count < MAX_LOCK_ATTEMPTS ) {
                    this.try_again(resolve,count)
                }
            } else {
                reject(result)
            }
        })
    }

    async access(count) {
        if ( count === undefined ) count = 0
        return new Promise((resolve,reject) => {
            this.asset_lock = false
            let result = shm.try_lock(this.shm_com_key)
            if ( result === true ) {
                this.asset_lock = true
                resolve(true)
            } else if ( result === false ) {
                this.try_again(resolve,reject,count)
            } else {
                reject(result)
            }
        })
    }

    lock_asset() {
        if ( this.proc_index >= 0 && this.com_buffer.length ) {
            if ( this.asset_lock ) return; // it is already locked
            //
            let result = shm.lock(this.shm_com_key)
            if ( result !== true ) {
                console.log(shm.get_last_mutex_reason(this.shm_com_key))
            }
        }
    }

    unlock_asset() {
        if ( this.proc_index >= 0 && this.com_buffer.length ) {
            let result = shm.unlock(this.shm_com_key)
            if ( result !== true ) {
                console.log(shm.get_last_mutex_reason(this.shm_com_key))
            }
        }
    }
    //
}

  // master_of_ceremonies -- a path
  // proc_names -- the list of js file names that will be attaching to the regions.
  // initializer -- true if master of ceremonies
  //
  // note: the initializer has to be called first before others.


class ShmLRUCache extends ReaderWriter {

    constructor(conf) {
        super(conf)
        this.conf = conf
        try {
            this.hasher = conf.hasher ? (() =>{ hasher = require(conf.hasher); return(hasher.init(conf.seed)); })()
                                      : (() => {
                                            return(init_default(conf.seed))
                                        })()
        } catch (e) {
            this.hasher = init_default(conf.seed)
        }
        //
        this.eviction_interval = null
        //
        if ( typeof conf._test_use_no_memory === "undefined" ) {
            this.init_shm_communicator(conf)
            this.init_cache(conf)    
        }
    }
    
    
    init_shm_communicator(conf) {
        //
        let sz = INTER_PROC_DESCRIPTOR_WORDS
        let proc_count = conf.proc_names ? conf.proc_names.length : 0
        //
        let mpath_match = -1
        if ( (typeof conf.token_path !== "undefined") ) {
            this.initializer = conf.am_initializer
            if ( this.initializer === undefined ) this.initializer = false
            proc_count = Math.max(proc_count,2)     // expect one attaching process other than initializer (May be just logging)
        } else {
            mpath_match = conf.master_of_ceremonies.indexOf(conf.module_path)
            this.initializer = ((proc_count > 0) && (mpath_match >= 0))
        }
        //
        if ( this.initializer ) {
            this.com_buffer = shm.create(proc_count*sz + SUPER_HEADER,'Uint32Array',this.shm_com_key)
        } else {
            this.com_buffer = shm.get(this.shm_com_key,'Uint32Array')
            if ( (mpath_match === -1) && (this.com_buffer === null) ) {
                console.dir(conf)
                console.log("module_path DOES NOT match with master_of_ceremonies OR master_of_ceremonies not yet initialized")
                throw(new Error("possible configuration error"))
            }
        }
        //
        let myname = (conf.module_path !== undefined) ? conf.module_path : conf.token_path
        if ( conf.proc_names !== undefined ) {
            this.proc_index = conf.proc_names.indexOf(myname)
            this.nprocs = conf.proc_names.length    
        } else {
            this.proc_index = this.initializer ? 0 : 1
        }
        let pid = this.pid
        let p_offset = NUM_INFO_FIELDS*(this.proc_index) + SUPER_HEADER
        this.com_buffer[p_offset + PID_INDEX] = pid
        this.com_buffer[p_offset + WRITE_FLAG_INDEX] = 0
        this.com_buffer[p_offset + INFO_INDEX_LRU] = 0  //??
        this.com_buffer[p_offset + INFO_INDEX_HH] = 0  //??
        //
        shm.init_mutex(this.shm_com_key,this.initializer)        // put the mutex at the very start of the communicator region.
    }


    // ----
    init_cache(conf) {
        this.record_size = conf.record_size
        this.count = conf.el_count
        //
        if ( this.initializer ) {
            let sz = ((this.count*this.record_size) + LRU_HEADER)
            this.lru_buffer =  shm.create(sz);
            this.lru_key = this.lru_buffer.key
            this.count = shm.initLRU(this.lru_key,this.record_size,sz,true)
            //
            sz = (2*this.count*(WORD_SIZE + LONG_WORD_SIZE) + HH_HEADER_SIZE)
            this.hh_bufer = shm.create(sz); 
            this.hh_key = this.hh_bufer.key
            shm.initHopScotch(this.hh_key,this.lru_key,true,this.count)
            //
            let p_offset = SUPER_HEADER  // even is the initializer is not at 0, all procs can read from zero
            this.com_buffer[p_offset + INFO_INDEX_LRU] = this.lru_key
            this.com_buffer[p_offset + INFO_INDEX_HH] = this.hh_key
            if ( conf.evictions_timeout ) {
                this.setup_eviction_proc(conf)
            }
        } else {
            let p_offset = SUPER_HEADER
            this.lru_key = this.com_buffer[p_offset + INFO_INDEX_LRU]
            this.hh_key = this.com_buffer[p_offset + INFO_INDEX_HH]
            //
            this.lru_buffer = shm.get(this.lru_key); //
            let sz = this.count*(this.record_size + LRU_HEADER)
            this.count = shm.initLRU(this.lru_key,this.record_size,sz,false)
            this.hh_bufer = shm.get(this.hh_key);
            shm.initHopScotch(this.hh_key,this.lru_key,false,this.count)
            //
        }
    }

    // ---- ---- ---- ---- ---- ---- ---- ---- ----

    hash(value) {
        let hh = this.hasher(value)
        let top = hh % this.count
        let augmented_hash_token = top + '-' + hh
        return( augmented_hash_token )
    }

    async set(hash_augmented,value) {
        if ( typeof value === 'string' ) {
            if ( !(value.length) ) return(-1)
            if ( value.length > this.record_size ) return(-1)    
        } else {
            value = (value).toString(16)
        }
        let pair = hash_augmented.split('-')
		let hash = parseInt(pair[0])
		let index = parseInt(pair[1])
        //
        if ( this.proc_index < 0 ) return  // guard against bad initialization and test cases
        this.lock_asset()
        let status = shm.set(this.lru_key,value,hash,index)
        if ( (status === false) || (status < 0) ) {
            // error condition...
            let time_shift = 0
            let reduced_max = 20
            let status_retry = 1
            while ( reduced_max > 0 ) {
                let [t_shift,rmax] = this.immediate_evictions(time_shift,reduced_max)
                status_retry = shm.set(this.lru_key,value,hash,index)
                if ( status_retry > 0 ) break;
                time_shift = t_shift
                reduced_max = rmax
            }
            if (  (status_retry === false) || (status_retry < 0) ) {
                throw new Error("evictions fail to regain space")
            }
        }
        this.unlock_asset()
    }

    async get(hash_augmented) {
        let pair = hash_augmented.split('-')
		let hash = parseInt(pair[0])
        let index = parseInt(pair[1])
        if ( this.proc_index < 0 ) return(false)  // guard against bad initialization and test cases
        this.lock_asset()
        let value = shm.get_el_hash(this.lru_key,hash,index)
        this.unlock_asset()
        return(value)
    }

    async del(hash_augmented) {
        let pair = hash_augmented.split('-')
		let hash = parseInt(pair[0])
        let index = parseInt(pair[1])
        if ( this.proc_index < 0 ) return(false)  // guard against bad initialization and test cases
        this.lock_asset()
        let result = shm.del_key(this.lru_key,hash,index)
        this.unlock_asset()
        return(result)
    }

    async delete(hash_augmented) {
        return this.del(hash_augmented)
    }


    // ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ----

    setup_eviction_proc(conf) {
        let eviction_timeout = (conf.sessions_length !== undefined) ? conf.sessions_length : DEFAULT_RESIDENCY_TIMEOUT
        let prev_milisec = (conf.aged_out_secs !== undefined) ? (conf.aged_out_secs*1000) : DEFAULT_RESIDENCY_TIMEOUT
        let cutoff = Date.now() - prev_milisec
        let max_evict = (conf.max_evictions !== undefined) ? parseInt(conf.max_evictions) : MAX_EVICTS
        let self = this
        if ( this.proc_index < 0 ) return(false)  // guard against bad initialization and test cases
        this.eviction_interval = setInterval(() => {
            let evict_list = shm.run_lru_eviction(this.lru_key,cutoff,max_evict)
            self.app_handle_evicted(evict_list)
        },eviction_timeout)
        return true
    }

    // ---- ---- ---- ---- ---- ---- ---- ---- ---- ----

    immediate_evictions(age_reduction,e_max) {
        let conf = this.conf
        let prev_milisec = (conf.aged_out_secs !== undefined) ? (conf.aged_out_secs*1000) : DEFAULT_RESIDENCY_TIMEOUT
        if ( (typeof age_reduction === 'number') && (age_reduction < prev_milisec)) {
            prev_milisec = age_reduction
        }
        let cutoff = Date.now() - prev_milisec
        let max_evict = (conf.max_evictions !== undefined) ? parseInt(conf.max_evictions) : MAX_EVICTS
        if ( (e_max !== undefined) && (e_max < max_evict) ) {
            max_evict = e_max
        }
        if ( this.proc_index < 0 ) return(0)  // guard against bad initialization and test cases
        //
        let evict_list = shm.run_lru_eviction(this.lru_key,cutoff,max_evict)
        if ( evict_list.length ) {
            let self = this
            setTimeout(() => {
                self.app_handle_evicted(evict_list)
            },250)    
        }
        return [(prev_milisec - 100),(max_evict - 2)]
    }

    // ---- ---- ---- ---- ---- ---- ---- ---- ---- ----

    disconnect(opt) {
        if ( this.eviction_interval !== null ) {
            clearInterval(this.eviction_interval)
        }
        if ( opt === true || ( (typeof opt === 'object') && ( opt.save_backup = true ) )) {
            // save buffers....
        }
        shm.detachAll()
        return(true)
    }

    // ---- ---- ---- ---- ---- ---- ---- ---- ---- ----

    /// handle_evicted(evict_list)
    app_handle_evicted(evict_list) {
        // app may decide to forward these elsewhere are send shutdown messages, etc.
    }

}



module.exports = ShmLRUCache