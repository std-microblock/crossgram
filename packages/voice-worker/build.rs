use std::env;
use std::fs;
use std::path::Path;

const SHIM_ABI_VERSION: u32 = 3;

fn main() {
    println!("cargo:rerun-if-env-changed=CROSSGRAM_TGCALLS_SHIM_INCLUDE_DIR");
    println!("cargo:rerun-if-env-changed=CROSSGRAM_TGCALLS_SHIM_LIB_DIR");

    if env::var_os("CARGO_FEATURE_NATIVE_TGCALLS_SHIM").is_none() {
        return;
    }

    let include_dir = env::var("CROSSGRAM_TGCALLS_SHIM_INCLUDE_DIR").expect(
        "native-tgcalls-shim requires CROSSGRAM_TGCALLS_SHIM_INCLUDE_DIR from the reviewed CMake package",
    );
    let lib_dir = env::var("CROSSGRAM_TGCALLS_SHIM_LIB_DIR").expect(
        "native-tgcalls-shim requires CROSSGRAM_TGCALLS_SHIM_LIB_DIR from the reviewed CMake package",
    );
    assert!(
        Path::new(&include_dir)
            .join("crossgram/tgcalls_shim.h")
            .is_file(),
        "CROSSGRAM_TGCALLS_SHIM_INCLUDE_DIR does not contain crossgram/tgcalls_shim.h"
    );
    assert!(
        Path::new(&lib_dir)
            .join("libcrossgram_tgcalls_shim.so")
            .is_file(),
        "CROSSGRAM_TGCALLS_SHIM_LIB_DIR does not contain libcrossgram_tgcalls_shim.so"
    );

    let abi_check = Path::new(&env::var("OUT_DIR").expect("Cargo provides OUT_DIR"))
        .join("tgcalls_shim_abi_check.c");
    fs::write(
        &abi_check,
        format!(
            "#include <crossgram/tgcalls_shim.h>\n_Static_assert(CROSSGRAM_TGCALLS_SHIM_ABI_VERSION == {SHIM_ABI_VERSION}, \"unexpected tgcalls shim ABI version\");\n"
        ),
    )
    .expect("could not write native tgcalls ABI check");
    let compiler = env::var("CC").unwrap_or_else(|_| "cc".into());
    let output = std::process::Command::new(compiler)
        .arg("-std=c11")
        .arg("-c")
        .arg(&abi_check)
        .arg("-o")
        .arg(
            Path::new(&env::var("OUT_DIR").expect("Cargo provides OUT_DIR"))
                .join("tgcalls_shim_abi_check.o"),
        )
        .arg(format!("-I{include_dir}"))
        .output()
        .expect("could not run C compiler for native tgcalls ABI check");
    assert!(
        output.status.success(),
        "native tgcalls ABI header does not match version {SHIM_ABI_VERSION}: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    println!("cargo:rustc-link-search=native={lib_dir}");
    println!("cargo:rustc-link-lib=dylib=crossgram_tgcalls_shim");
}
