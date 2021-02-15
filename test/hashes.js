const { XXHash32 } = require('xxhash-addon')


var g_app_seed = 0
var g_hasher32 = null



function default_hash(data) {
    if ( !(g_hasher32) ) return(0)
    g_hasher32.update(data)
    let h = g_hasher32.digest()
    let hh = h.readUInt32BE(0)
    g_hasher32.reset()
    //
    return hh
}


function init_default(seed) {
    g_app_seed = parseInt(seed,16);
    g_hasher32 = new XXHash32(g_app_seed);
    return default_hash
}


init_default(3456);
let b = Buffer.from("this is a test")
let hh = default_hash(b)
console.log(hh)


function test_method_sim(value) {
    let b = Buffer.from(value)
    let hh = default_hash(b)
    let top = hh % 200000
    let augmented_hash_token = top + '-' + hh
    return( augmented_hash_token )    
}

init_default(1234);
b = Buffer.from("this is a test")
hh = default_hash(b)
console.log(hh)


console.log(test_method_sim('jo@blo.com'))
console.log(test_method_sim('jane@do.com'))
console.log(test_method_sim('jo@blo.com'))
console.log(test_method_sim('jane@go.com'))