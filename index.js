const shm = require('shm-typed-lru')
const { XXHash32 } = require('xxhash32-node-cmake')
const ftok = require('ftok')

//
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

const DEFAULT_ELEMENT_COUNT = 1024

const DEFAULT_SET_ATTEMPTS = 10
const DEFAULT_GET_ATTEMPTS = 10
const DEFAULT_DEL_ATTEMPTS = 10


var g_app_seed = 0
var g_hasher32 = null


function default_hash(data) {
    if ( !(g_hasher32) ) return(0)
    try {
        let hh = g_hasher32.hash(data)
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


/**
 * In this module, the ReaderWriter represents on mutex fo lock operations, used to protect 
 * data structure changes on one HopScotch table comprising two shared memory sections, the 
 * storage region and the hash table.
 */
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
                    this.try_again(resolve,count)  // keep in mind that this not actually recursive
                }
            } else {
                reject(result)
            }
        })
    }


    /**
     * Calls the posix mutex try lock. Hence, if the thread is locked this will return
     * immediatly. If the mutex is locked, the lru module will return false. Otherwise, the
     * asset will be locked, and it must be unlocked after access. 
     * 
     * On failure to lock, this method will relinquish the attemp to lock on the asset to the event queue
     * by calling `try_again`.
     */
    async access(count) {
        if ( count === undefined ) count = 0
        return new Promise(async (resolve,reject) => {
            if ( this.asset_lock ) {  // will await some number of counts to acquire the in this process (if this is reachable)
                await this.try_again(resolve,reject,count)
            } else {
                let result = shm.try_lock(this.shm_com_key)
                if ( result === true ) {
                    this.asset_lock = true    // avoid calling the POSIX methods until this is clear
                    resolve(true)
                } else if ( result === false ) {
                    await this.try_again(resolve,reject,count)
                } else {
                    reject(result)
                }    
            }
        })
    }

    async lock_asset_access(count) {
        return await this.access(count)
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
            } else {
                this.asset_lock = false
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

/**
 * 
 * This class defines the relationship between the hash table and its use as an LRU. 
 * This module accepts the applications hash of the data being used to identify the data.
 * The hash must be 32 bits or less. Because, the size of the hash table is likely to be 
 * smaller than the range of the hashes, this class augments the hash key by 
 * taking the modulus of the hash with respect to the number of elements that the table will accomodate.
 * 
 * As long as the max table size remains fixed, the augmented hash will not have to change. 
 * Objects may be updated against the old hash. If an application wishes to change the hash of an object to reflect
 * the change of the data, the object should first be removed from the hash table and then be reinserted.
 * 
 */
class ShmLRUCache extends ReaderWriter {

    constructor(conf) {
        super(conf)
        this.count = DEFAULT_ELEMENT_COUNT
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
        this._allowed_set_attempts = DEFAULT_SET_ATTEMPTS
        this._allowed_get_attempts = DEFAULT_GET_ATTEMPTS
        this._allowed_del_attempts = DEFAULT_DEL_ATTEMPTS
        //
        this.eviction_interval = null
        this._use_immediate_eviction = false
        this.hop_scotch_scale = conf.hop_scotch_scale ? parseInt(conf.hop_scotch_scale) : 2
        this._max_evicts = (conf.max_evictions !== undefined) ? parseInt(conf.max_evictions) : false
        //
        if ( typeof conf._test_use_no_memory === "undefined" ) {
            this.init_shm_communicator(conf)
            this.init_cache(conf)    
        }
    }
    
    
    /**
     * Does the intialization of the shared memory region from the perspective of the 
     * calling process. 
     * 
     * The field `initializer` will determine which process creates the shared memory section and which one attach. 
     * Just one process creates the section and for that process `initializer` is set to true. All others are set to false.
     * The initializing process should be call before the others. This method does not attempt to make extra attempts to attach
     * to memory and simply fails by throwing an exception.
     * 
     * Each process has the opportunity to identify itself in the `com_buffer` table, which is part of the shared memory region
     * holding a mutex governing the use of the LRU tables. 
     * 
     * Every processes may call the method to intialize the mutex. The initialization method is called with the 
     * field `initializer`, which is true for the creator and false for those attaching. (as before)
     * 
     * @param {object} conf 
     */
    init_shm_communicator(conf) {
        //
        let sz = INTER_PROC_DESCRIPTOR_WORDS
        let proc_count = conf.proc_names ? conf.proc_names.length : 0
        //
        let mpath_match = -1
        if ( (typeof conf.token_path !== "undefined") ) {  // better idea
            this.initializer = conf.am_initializer
            if ( this.initializer === undefined ) this.initializer = false
            proc_count = Math.max(proc_count,2)     // expect one attaching process other than initializer (May be just logging)
        } else {
            mpath_match = conf.master_of_ceremonies.indexOf(conf.module_path)  // old idea
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
    /**
     * 
     * @param {object} conf 
     */
    init_cache(conf) {
        //
        this.record_size = parseInt(conf.record_size)
        this.count = (conf.el_count !== undefined) ? parseInt(conf.el_count) : DEFAULT_ELEMENT_COUNT;
        //
        if ( this.initializer ) {
            let sz = ((this.count*this.record_size) + LRU_HEADER)
            this.lru_buffer =  shm.create(sz);
            this.lru_key = this.lru_buffer.key
            this.count = shm.initLRU(this.lru_key,this.record_size,sz,true)
            //
            let hss = this.hop_scotch_scale
            sz = (hss*this.count*(WORD_SIZE + LONG_WORD_SIZE) + HH_HEADER_SIZE)
            this.hh_bufer = shm.create(sz); 
            this.hh_key = this.hh_bufer.key
            shm.initHopScotch(this.hh_key,this.lru_key,true,(this.count*hss))
            //
            let p_offset = SUPER_HEADER  // even is the initializer is not at 0, all procs can read from zero
            this.com_buffer[p_offset + INFO_INDEX_LRU] = this.lru_key
            this.com_buffer[p_offset + INFO_INDEX_HH] = this.hh_key
            // Eviction -- only the process that manages memory can setup periodic eviction.
            if ( conf.evictions_timeout ) {
                this.setup_eviction_proc(conf)
            }
            this._use_immediate_eviction = conf.immediate_evictions ? conf.immediate_evictions : false
        } else {
            let p_offset = SUPER_HEADER
            this.lru_key = this.com_buffer[p_offset + INFO_INDEX_LRU]
            this.hh_key = this.com_buffer[p_offset + INFO_INDEX_HH]
            //
            let hss = this.hop_scotch_scale
            this.lru_buffer = shm.get(this.lru_key); //
            let sz = this.count*(this.record_size + LRU_HEADER)
            this.count = shm.initLRU(this.lru_key,this.record_size,sz,false)
            this.hh_bufer = shm.get(this.hh_key);
            shm.initHopScotch(this.hh_key,this.lru_key,false,(this.count*hss))
            //
        }
    }

    // ---- ---- ---- ---- ---- ---- ---- ---- ----

    hash(value) {
        let hh = this.hasher(value)
        return( this.augment_hash(hh) )
    }

    hash_pair(value) {
        let hh = this.hasher(value)
        return( this.augmented_hash_pair(hh) )
    }

    // ----
    pure_hash(value) {
        let hh = this.hasher(value)
        return hh
    }

    // ----
    /**
     * 
     * The application determines the key, which should be a numeric hash of the value. 
     * The hash of the value should be almost unique for smooth operation of the underlying hash table data structure.
     * 
     * This method returns an augmented hash, which is really the hash annotated with its
     * modulus determined by the hash table size.
     * 
     * @param {Number} key 
     * @param {object} value 
     * @returns {string} - a hyphenated string where the left is the modulus of the hash and the right is the hash itself.
     */

    augment_hash(hash) {
        let hh = hash
        let top = hh % this.count
        let augmented_hash_token = `${top}-${hh}`
        return( augmented_hash_token )
    }

    /**
     * 
     * The application determines the key, which should be a numeric hash of the value. 
     * The hash of the value should be almost unique for smooth operation of the underlying hash table data structure.
     * 
     * This method returns an augmented hash, which is really the hash annotated with its
     * modulus determined by the hash table size.
     * 
     * @param {Number} key 
     * @param {object} value 
     * @returns {Array} - a hyphenated string where a[0] is the modulus of the hash and a[1] is the hash itself.
     */

    augmented_hash_pair(hash) {
        let hh = hash
        let top = hh % this.count
        return( [top,hh] )
    }
  
    // ----
    /**
     * 
     * @param {string|Array} hash_augmented - hyphentated string or a pair
     * @param {string|Number} value 
     * @returns 
     */
    async set(hash_augmented,value) {
        if ( typeof value === 'string' ) {
            if ( !(value.length) ) return(-1)
            if ( value.length > this.record_size ) return(-1)    
        } else {
            value = (value).toString(16)
        }
        let pair = Array.isArray(hash_augmented) ?  hash_augmented : hash_augmented.split('-')
		let hash = parseInt(pair[0])
		let index = parseInt(pair[1])
        //
        if ( this.proc_index < 0 ) return  // guard against bad initialization and test cases
        try {
            await this.lock_asset_access(this._allowed_set_attempts)   // locks if possible
        } catch (e) {
            return false   // at this point the method could not gain access to lock; so, this method will not unlock
        }
        //
        let status = shm.set(this.lru_key,value,hash,index)   // SET
        //
        if ( ((status === false) || (status < 0)) && this._use_immediate_eviction) {
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
        return status
    }

    /**
     * 
     * @param {string} hash_augmented 
     * @returns 
     */
    async get(hash_augmented) {
        let pair = Array.isArray(hash_augmented) ?  hash_augmented : hash_augmented.split('-')
		let hash = parseInt(pair[0])
        let index = parseInt(pair[1])
        if ( this.proc_index < 0 ) return(false)  // guard against bad initialization and test cases
        try {
            await this.lock_asset_access(this._allowed_get_attempts)   // locks if possible
        } catch (e) {
            return false // at this point the method could not gain access to lock; so, this method will not unlock
        }
        let value = shm.get_el_hash(this.lru_key,hash,index)
        this.unlock_asset()
        return(value)
    }

    /**
     * 
     * @param {string} hash_augmented 
     * @returns 
     */
    async del(hash_augmented) {
        let pair = Array.isArray(hash_augmented) ?  hash_augmented : hash_augmented.split('-')
		let hash = parseInt(pair[0])
        let index = parseInt(pair[1])
        if ( this.proc_index < 0 ) return(false)  // guard against bad initialization and test cases
        try {
            await this.lock_asset_access(this._allowed_del_attempts)   // locks if possible
        } catch (e) {
            return false // at this point the method could not gain access to lock; so, this method will not unlock
        }
        let result = shm.del_key(this.lru_key,hash,index)
        this.unlock_asset()
        return(result)
    }

    /**
     * 
     * @param {string} hash_augmented 
     * @returns 
     */
    async delete(hash_augmented) {
        return this.del(hash_augmented)
    }


    // ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ----

    /**
     * 
     * Called from within the `init_cache` method if the timeout is being used. 
     * 
     * @param {*} conf 
     * @returns 
     */
    setup_eviction_proc(conf) {
        let eviction_timeout = (conf.sessions_length !== undefined) ? conf.sessions_length : DEFAULT_RESIDENCY_TIMEOUT
        let prev_milisec = (conf.aged_out_secs !== undefined) ? (conf.aged_out_secs*1000) : DEFAULT_RESIDENCY_TIMEOUT
        let cutoff = Date.now() - prev_milisec
        let max_evict = (this._max_evicts !== false) ? this._max_evicts : MAX_EVICTS
        let self = this
        if ( this.proc_index < 0 ) return(false)  // guard against bad initialization and test cases
        this.eviction_interval = setInterval(() => {
            let evict_list = shm.run_lru_eviction(this.lru_key,cutoff,max_evict)
            self.app_handle_evicted(evict_list)
        },eviction_timeout)
        return true
    }

    // ---- ---- ---- ---- ---- ---- ---- ---- ---- ----

    /**
     * Called from within the `set` method.  This will run evictions and return a list of evicted values.
     * The timeout is applied to an application method given to an exention of this class. 
     * 
     * @param {*} age_reduction 
     * @param {*} e_max 
     * @returns 
     */
    immediate_evictions(age_reduction,e_max) {
        let conf = this.conf
        let prev_milisec = (conf.aged_out_secs !== undefined) ? (conf.aged_out_secs*1000) : DEFAULT_RESIDENCY_TIMEOUT
        if ( (typeof age_reduction === 'number') && (age_reduction < prev_milisec)) {
            prev_milisec = age_reduction
        }
        let cutoff = Date.now() - prev_milisec
        let max_evict = (this._max_evicts !== false) ? this._max_evicts : MAX_EVICTS
        if ( (e_max !== undefined) && (e_max < max_evict) ) {  // upper limit on the calling value
            max_evict = e_max
        }
        if ( max_evict <= 0 ) return([0,0])
        if ( this.proc_index < 0 ) return([0,0])  // guard against bad initialization and test cases
        //
        let evict_list = shm.run_lru_eviction(this.lru_key,cutoff,max_evict)
        if ( evict_list.length ) {
            let self = this
            setTimeout(() => {
                self.app_handle_evicted(evict_list)
            },250)    
        }
        //
        return [(prev_milisec - 100),(max_evict - 2)]
    }


    /**
     * This method calls on the mutex lock. It is not meant to be called within the `set` method.
     * 
     * @param {*} age_reduction 
     * @param {*} e_max 
     * @returns 
     */
    immediate_mapped_evictions(age_reduction,e_max) {
        let conf = this.conf
        let prev_milisec = (conf.aged_out_secs !== undefined) ? (conf.aged_out_secs*1000) : DEFAULT_RESIDENCY_TIMEOUT
        if ( (typeof age_reduction === 'number') && (age_reduction < prev_milisec)) {
            prev_milisec = age_reduction
        }
        let cutoff = Date.now() - prev_milisec
        let max_evict = (this._max_evicts !== false) ? this._max_evicts : MAX_EVICTS
        if ( (e_max !== undefined) && (e_max < max_evict) ) {  // upper limit on the calling value
            max_evict = e_max
        }
        if ( max_evict <= 0 ) return([0,0])
        if ( this.proc_index < 0 ) return([0,0])  // guard against bad initialization and test cases
        //
        this.lock_asset()
        let evict_list = shm.run_lru_eviction_get_values(this.lru_key,cutoff,max_evict)
        this.unlock_asset()
        //
        return evict_list
    }


    /**
     * This method calls on the mutex lock. It is not meant to be called within the `set` method.
     * 
     * @param {*} hash_augmented 
     * @param {*} age_reduction 
     * @param {*} e_max 
     * @returns 
     */
    immediate_targeted_evictions(hash_augmented,age_reduction,e_max) {
        let pair = Array.isArray(hash_augmented) ?  hash_augmented : hash_augmented.split('-')
		let hash = parseInt(pair[0])
        let index = parseInt(pair[1])
        if ( this.proc_index < 0 ) return(false)  // guard against bad initialization and test cases
        //
        let conf = this.conf
        let prev_milisec = (conf.aged_out_secs !== undefined) ? (conf.aged_out_secs*1000) : DEFAULT_RESIDENCY_TIMEOUT
        if ( (typeof age_reduction === 'number') && (age_reduction < prev_milisec)) {
            prev_milisec = age_reduction
        }
        let cutoff = Date.now() - prev_milisec
        let max_evict = (this._max_evicts !== false) ? this._max_evicts : MAX_EVICTS
        if ( (e_max !== undefined) && (e_max < max_evict) ) {  // upper limit on the calling value
            max_evict = e_max
        }
        if ( max_evict <= 0 ) return([0,0])
        if ( this.proc_index < 0 ) return([0,0])  // guard against bad initialization and test cases
        //
        this.lock_asset()
        let evict_list = shm.run_lru_targeted_eviction_get_values(this.lru_key,cutoff,max_evict,hash,index)
        this.unlock_asset()
        //
        return evict_list
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


    set_sigint_proc_stop(func) {
        shm.set_sigint_proc_stop(func)
    }

}



module.exports = ShmLRUCache