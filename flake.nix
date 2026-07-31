{
  description = "Crossgram voice relay development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {nixpkgs, ...}: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {inherit system;};
    lib = pkgs.lib;

    sourcePins = {
      tdesktop = {
        url = "https://github.com/telegramdesktop/tdesktop/archive/f238e46ff988ec502290f6e691bd67c11cf5c75a.tar.gz";
        rev = "f238e46ff988ec502290f6e691bd67c11cf5c75a";
        hash = "sha256-QSKImOFeefC5frgs1AtXpFoSvPC95DOPJ5485tDx67c=";
      };
      tdesktop-cmake-helpers = {
        url = "https://github.com/desktop-app/cmake_helpers/archive/80cd031dc4c81805b8bb118e8250356afaad6614.tar.gz";
        rev = "80cd031dc4c81805b8bb118e8250356afaad6614";
        hash = "sha256-8vVignSYF4N1pFHdNEMFu2OxyiBHFLkr80IcYgU1nJI=";
      };
      tgcalls = {
        url = "https://github.com/TelegramMessenger/tgcalls/archive/2faee3b5524f54d56c91c2058c00e11c656a74b3.tar.gz";
        rev = "2faee3b5524f54d56c91c2058c00e11c656a74b3";
        hash = "sha256-+2z28JK8uYbr532QOFsiSBIc4JhRWBvIzjgkGiSf/Cs=";
      };
      tg-owt = {
        url = "https://github.com/desktop-app/tg_owt.git";
        rev = "5c5c71258777d0196dbb3a09cc37d2f56ead28ab";
        hash = "sha256-4CAo3lbj2acj9UsNjUDnyF+tjUrah53DylKuFLewQwA=";
      };
    };

    fetchPinnedSource = pin:
      pkgs.fetchzip {
        inherit (pin) url hash;
        stripRoot = true;
      };

    tdesktopSource = fetchPinnedSource sourcePins.tdesktop;
    tdesktopHelpersSource = fetchPinnedSource sourcePins.tdesktop-cmake-helpers;
    tgcallsSource = fetchPinnedSource sourcePins.tgcalls;
    tgOwtSource =
      (builtins.fetchTree {
        type = "git";
        inherit (sourcePins.tg-owt) url rev;
        narHash = sourcePins.tg-owt.hash;
        submodules = true;
      }).outPath;

    tdesktopHelpers = pkgs.runCommand "tdesktop-tgcalls-cmake-helpers" {} ''
      mkdir -p "$out"
      cp ${tdesktopHelpersSource}/init_target.cmake "$out/"
      cp ${tdesktopHelpersSource}/nice_target_sources.cmake "$out/"
      cp ${tdesktopHelpersSource}/target_compile_options_if_exists.cmake "$out/"
      cp ${tdesktopSource}/Telegram/cmake/lib_tgcalls.cmake "$out/"
      cp ${tdesktopSource}/LEGAL "$out/Telegram-Desktop-LEGAL"
    '';

    tgOwtInputs = with pkgs; [
      crc32c
      ffmpeg
      libjpeg_turbo
      libvpx
      openh264
      openssl
      opus
      srtp
      zlib
    ];

    tgOwt = pkgs.stdenv.mkDerivation {
      pname = "tg-owt";
      version = sourcePins.tg-owt.rev;
      src = tgOwtSource;
      strictDeps = true;
      nativeBuildInputs = with pkgs; [cmake ninja pkg-config python3];
      buildInputs = tgOwtInputs;
      propagatedBuildInputs = tgOwtInputs;
      cmakeFlags = [
        "-DBUILD_SHARED_LIBS=OFF"
        "-DCMAKE_DISABLE_FIND_PACKAGE_absl=ON"
        "-DTG_OWT_USE_PIPEWIRE=OFF"
        "-DTG_OWT_USE_X11=OFF"
        "-DTG_OWT_BUILD_AUDIO_BACKENDS=OFF"
      ];
      SOURCE_DATE_EPOCH = "1";
      ZERO_AR_DATE = "1";
    };

    linkedComponents = with pkgs; [
      {
        id = "tg-owt";
        name = "tg_owt";
        version = sourcePins.tg-owt.rev;
        license = "BSD-3-Clause";
        source = tgOwtSource;
      }
      {
        id = "ffmpeg";
        name = "FFmpeg";
        version = ffmpeg.version;
        license = "(LGPL-2.1-or-later OR GPL-2.0-or-later OR LGPL-3.0-or-later OR GPL-3.0-or-later)";
        source = ffmpeg.src;
      }
      {
        id = "openssl";
        name = "OpenSSL";
        version = openssl.version;
        license = "Apache-2.0";
        source = openssl.src;
      }
      {
        id = "rnnoise";
        name = "rnnoise";
        version = rnnoise.version;
        license = "BSD-3-Clause";
        source = rnnoise.src;
      }
      {
        id = "zlib";
        name = "zlib";
        version = zlib.version;
        license = "Zlib";
        source = zlib.src;
      }
      {
        id = "crc32c";
        name = "CRC32C";
        version = crc32c.version;
        license = "BSD-3-Clause";
        source = crc32c.src;
      }
      {
        id = "libjpeg-turbo";
        name = "libjpeg-turbo";
        version = libjpeg_turbo.version;
        license = "IJG";
        source = libjpeg_turbo.src;
      }
      {
        id = "libvpx";
        name = "libvpx";
        version = libvpx.version;
        license = "BSD-3-Clause";
        source = libvpx.src;
      }
      {
        id = "openh264";
        name = "OpenH264";
        version = openh264.version;
        license = "BSD-2-Clause";
        source = openh264.src;
      }
      {
        id = "opus";
        name = "Opus";
        version = opus.version;
        license = "BSD-3-Clause";
        source = opus.src;
      }
      {
        id = "libsrtp";
        name = "libsrtp";
        version = srtp.version;
        license = "BSD-3-Clause";
        source = srtp.src;
      }
      {
        id = "gcc-libstdcxx";
        name = "GNU C++ runtime";
        version = pkgs.stdenv.cc.cc.version;
        license = "GPL-3.0-or-later WITH GCC-exception-3.1";
        source = pkgs.stdenv.cc.cc.src;
      }
      {
        id = "libgcc";
        name = "GNU compiler runtime";
        version = pkgs.stdenv.cc.cc.version;
        license = "GPL-3.0-or-later WITH GCC-exception-3.1";
        source = pkgs.stdenv.cc.cc.src;
      }
      {
        id = "glibc";
        name = "GNU C Library";
        version = glibc.version;
        license = "LGPL-2.1-or-later";
        source = glibc.src;
      }
    ];

    tgcallsStaticInputs = with pkgs; [
      tgOwt
      ffmpeg
      openssl
      rnnoise
      zlib
    ];

    sourceManifest = pkgs.writeText "tgcalls-source-provenance.json" (builtins.toJSON {
      schema = "crossgram.tgcalls.provenance.v1";
      artifact = "liblib_tgcalls.a";
      sources = {
        TelegramDesktop =
          sourcePins.tdesktop
          // {
            role = "Telegram/cmake/lib_tgcalls.cmake and LEGAL provenance only";
          };
        TelegramDesktopCmakeHelpers =
          sourcePins.tdesktop-cmake-helpers
          // {
            role = "only init_target.cmake, nice_target_sources.cmake, and target_compile_options_if_exists.cmake are used";
          };
        tgcalls = sourcePins.tgcalls // {role = "lib_tgcalls source";};
        tgOwt = sourcePins.tg-owt // {role = "static WebRTC implementation";};
      };
      build = {
        sourceDateEpoch = 1;
        tgOwtCmakeFlags = [
          "-DBUILD_SHARED_LIBS=OFF"
          "-DCMAKE_DISABLE_FIND_PACKAGE_absl=ON"
          "-DTG_OWT_USE_PIPEWIRE=OFF"
          "-DTG_OWT_USE_X11=OFF"
          "-DTG_OWT_BUILD_AUDIO_BACKENDS=OFF"
        ];
        noCallProbe = "links liblib_tgcalls.a through the upstream tgcalls::isGzip symbol address only; it never invokes that function or any call, network, or media operation";
        localPatches = [
          "fake-adm-stop-recording.patch: stops FakeAudioDeviceModule recording before destruction"
          "synchronous-teardown.patch: synchronously tears down manager, network, and media before releasing EncryptionKey"
        ];
      };
    });

    tgcallsSbom = pkgs.writeText "tgcalls-static-closure.spdx.json" (builtins.toJSON {
      SPDXID = "SPDXRef-DOCUMENT";
      SPDXVersion = "SPDX-2.3";
      name = "crossgram-tgcalls-static-closure";
      dataLicense = "CC0-1.0";
      documentNamespace = "https://crossgram.invalid/sbom/tgcalls-static-closure";
      creationInfo = {
        creators = ["Tool: Nix"];
        created = "1970-01-01T00:00:01Z";
      };
      packages =
        [
          {
            SPDXID = "SPDXRef-tgcalls";
            name = "tgcalls";
            versionInfo = sourcePins.tgcalls.rev;
            downloadLocation = sourcePins.tgcalls.url;
            licenseConcluded = "BSD-3-Clause";
            licenseDeclared = "BSD-3-Clause";
          }
          {
            SPDXID = "SPDXRef-tgcalls-no-call-probe";
            name = "tgcalls no-call probe";
            versionInfo = sourcePins.tgcalls.rev;
            downloadLocation = "NOASSERTION";
            licenseConcluded = "BSD-3-Clause";
            licenseDeclared = "BSD-3-Clause";
          }
        ]
        ++ map (component: {
          SPDXID = "SPDXRef-${component.id}";
          name = component.name;
          versionInfo = component.version;
          downloadLocation = "NOASSERTION";
          licenseConcluded = component.license;
          licenseDeclared = component.license;
        })
        linkedComponents;
      relationships =
        [
          {
            spdxElementId = "SPDXRef-DOCUMENT";
            relationshipType = "DESCRIBES";
            relatedSpdxElement = "SPDXRef-tgcalls";
          }
          {
            spdxElementId = "SPDXRef-DOCUMENT";
            relationshipType = "DESCRIBES";
            relatedSpdxElement = "SPDXRef-tgcalls-no-call-probe";
          }
          {
            spdxElementId = "SPDXRef-tgcalls-no-call-probe";
            relationshipType = "STATIC_LINK";
            relatedSpdxElement = "SPDXRef-tgcalls";
          }
        ]
        ++ map (id: {
          spdxElementId = "SPDXRef-tgcalls";
          relationshipType = "STATIC_LINK";
          relatedSpdxElement = "SPDXRef-${id}";
        }) ["tg-owt" "ffmpeg" "openssl" "rnnoise" "zlib"]
        ++ map (id: {
          spdxElementId = "SPDXRef-tg-owt";
          relationshipType = "STATIC_LINK";
          relatedSpdxElement = "SPDXRef-${id}";
        }) ["crc32c" "ffmpeg" "libjpeg-turbo" "libvpx" "openh264" "openssl" "opus" "libsrtp" "zlib"]
        ++ map (id: {
          spdxElementId = "SPDXRef-tgcalls-no-call-probe";
          relationshipType = "DYNAMIC_LINK";
          relatedSpdxElement = "SPDXRef-${id}";
        }) ["gcc-libstdcxx" "libgcc" "glibc"];
    });

    tgcallsLicenses = pkgs.runCommand "tgcalls-artifact-licenses" {
      nativeBuildInputs = with pkgs; [gnutar gzip xz];
    } ''
      copy_notices() {
        local component="$1"
        local source="$2"
        local work
        local root

        if test -d "$source"; then
          root="$source"
        else
          work="$(mktemp -d)"
          tar -xf "$source" -C "$work"
          root="$work"
        fi

        (
          cd "$root"
          find . -type f \( -iname 'license*' -o -iname 'copying*' -o -iname 'notice*' -o -iname 'patent*' -o -iname 'authors*' \) -print0 \
            | LC_ALL=C sort -z \
            | while IFS= read -r -d $'\0' file; do
                install -Dm644 "$file" "$out/$component/$file"
              done
        )
        test "$(find "$out/$component" -type f -size +203c | wc -l)" -gt 0
      }

      copy_notices tgcalls ${tgcallsSource}
      copy_notices tgcalls-no-call-probe ${tgcallsSource}
      ${lib.concatMapStringsSep "\n" (component: ''
        copy_notices ${component.id} ${component.source}
      '') linkedComponents}

      {
        printf '%s\t%s\n' tgcalls ${sourcePins.tgcalls.rev}
        printf '%s\t%s\n' tgcalls-no-call-probe ${sourcePins.tgcalls.rev}
        ${lib.concatMapStringsSep "\n" (component: ''
          printf '%s\t%s\n' ${component.id} '${component.name}@${component.version}'
        '') linkedComponents}
      } > "$out/SOURCE-MAPPING.tsv"
      (
        cd "$out"
        find . -type f ! -name MANIFEST.sha256 -print0 \
          | LC_ALL=C sort -z \
          | xargs -0 sha256sum > MANIFEST.sha256
        sha256sum --check MANIFEST.sha256
      )
    '';

    tgcallsArtifact = pkgs.stdenv.mkDerivation {
      pname = "tgcalls-artifact";
      version = sourcePins.tgcalls.rev;
      dontUnpack = true;
      dontConfigure = true;
      strictDeps = true;
      nativeBuildInputs = with pkgs; [cmake ninja pkg-config];
      buildInputs = tgcallsStaticInputs;
      SOURCE_DATE_EPOCH = "1";
      ZERO_AR_DATE = "1";
      buildPhase = ''
        runHook preBuild
        mkdir source
        cp -R ${tgcallsSource} source/tgcalls
        chmod -R u+w source
        install -Dm644 ${./third_party/tgcalls/CMakeLists.txt} source/CMakeLists.txt
        install -Dm644 ${./third_party/tgcalls/no_call.cpp} source/no_call.cpp
        substituteInPlace source/CMakeLists.txt \
          --replace-fail '@tgcallsSource@' "$PWD/source" \
          --replace-fail '@tdesktopHelpers@' '${tdesktopHelpers}'
        patch -d source/tgcalls -p1 < ${./third_party/tgcalls/patches/fake-adm-stop-recording.patch}
        patch -d source/tgcalls -p1 < ${./third_party/tgcalls/patches/synchronous-teardown.patch}
        cmake -S source -B build -G Ninja \
          -DCMAKE_BUILD_TYPE=Release \
          -DCMAKE_PREFIX_PATH=${tgOwt}
        cmake --build build --target lib_tgcalls tgcalls_no_call_probe -j"$NIX_BUILD_CORES"
        runHook postBuild
      '';
      doCheck = true;
      checkPhase = ''
        runHook preCheck
        test "$(ar t build/liblib_tgcalls.a | wc -l)" -eq 51
        nm -C --defined-only build/tgcalls_no_call_probe \
          | grep -F 'tgcalls::isGzip(std::vector<unsigned char, std::allocator<unsigned char> > const&)' >/dev/null
        readelf -Ws build/tgcalls_no_call_probe \
          | grep -F '_ZN7tgcalls6isGzip' >/dev/null
        grep -F 'liblib_tgcalls.a(gzip.cpp.o)' build/tgcalls_no_call_probe.map >/dev/null
        ./build/tgcalls_no_call_probe
        runHook postCheck
      '';
      installPhase = ''
        runHook preInstall
        install -Dm644 build/liblib_tgcalls.a "$out/lib/liblib_tgcalls.a"
        install -Dm755 build/tgcalls_no_call_probe "$out/bin/tgcalls-no-call-probe"
        install -Dm644 build/tgcalls_no_call_probe.map "$out/share/tgcalls-artifact/tgcalls_no_call_probe.map"
        sed -Ei 's@/nix/store/[0-9a-z]{32}-@<nix-store>/@g' "$out/share/tgcalls-artifact/tgcalls_no_call_probe.map"
        mkdir -p "$out/include"
        cp -R source/tgcalls/tgcalls "$out/include/tgcalls"
        install -Dm644 ${sourceManifest} "$out/share/tgcalls-artifact/provenance.json"
        install -Dm644 ${tgcallsSbom} "$out/share/tgcalls-artifact/tgcalls-static-closure.spdx.json"
        cp -R ${tgcallsLicenses} "$out/share/tgcalls-artifact/licenses"
        runHook postInstall
      '';
      postFixup = ''
        (
          cd "$out"
          find bin include lib share -type f -print0 \
            | LC_ALL=C sort -z \
            | xargs -0 sha256sum > MANIFEST.sha256
        )
      '';
      doInstallCheck = true;
      installCheckPhase = ''
        runHook preInstallCheck
        (
          cd "$out"
          sha256sum --check MANIFEST.sha256
        )
        (
          cd "$out/share/tgcalls-artifact/licenses"
          sha256sum --check MANIFEST.sha256
        )
        nm -C --defined-only "$out/bin/tgcalls-no-call-probe" \
          | grep -F 'tgcalls::isGzip(std::vector<unsigned char, std::allocator<unsigned char> > const&)' >/dev/null
        readelf -Ws "$out/bin/tgcalls-no-call-probe" \
          | grep -F '_ZN7tgcalls6isGzip' >/dev/null
        grep -F 'liblib_tgcalls.a(gzip.cpp.o)' "$out/share/tgcalls-artifact/tgcalls_no_call_probe.map" >/dev/null
        ! grep -R -F 'Source and license mapping:' "$out/share/tgcalls-artifact/licenses"
        test "$(wc -l < "$out/share/tgcalls-artifact/licenses/SOURCE-MAPPING.tsv")" -eq 16
        for component in tgcalls tgcalls-no-call-probe tg-owt ffmpeg openssl rnnoise zlib crc32c libjpeg-turbo libvpx openh264 opus libsrtp gcc-libstdcxx libgcc glibc; do
          test "$(find "$out/share/tgcalls-artifact/licenses/$component" -type f -size +203c | wc -l)" -gt 0
        done
        runHook postInstallCheck
      '';
    };

    tgcallsShim = pkgs.stdenv.mkDerivation {
      pname = "crossgram-tgcalls-shim";
      version = sourcePins.tgcalls.rev;
      src = builtins.path {
        path = ./native/tgcalls-shim;
        name = "crossgram-tgcalls-shim-source";
      };
      strictDeps = true;
      nativeBuildInputs = with pkgs; [cmake ninja pkg-config];
      buildInputs = tgcallsStaticInputs ++ [tgcallsArtifact];
      propagatedBuildInputs = tgcallsStaticInputs ++ [tgcallsArtifact];
      cmakeFlags = [
        "-DCROSSGRAM_TGCALLS_SHIM_BUILD_TESTS=ON"
        "-DCROSSGRAM_TGCALLS_SHIM_ENABLE_ARTIFACT=ON"
        "-DCROSSGRAM_TGCALLS_ARTIFACT_ROOT=${tgcallsArtifact}"
      ];
      SOURCE_DATE_EPOCH = "1";
      doCheck = true;
      checkPhase = ''
        runHook preCheck
        ctest --output-on-failure
        runHook postCheck
      '';
      installPhase = ''
        runHook preInstall
        cmake --install .
        runHook postInstall
      '';
      doInstallCheck = true;
      installCheckPhase = ''
        runHook preInstallCheck
        test -s "$out/lib/libcrossgram_tgcalls_shim.a"
        test -s "$out/include/crossgram/tgcalls_shim.h"
        test -s "$out/lib/cmake/CrossgramTgcallsShim/CrossgramTgcallsShimConfig.cmake"
        mkdir consumer
        printf '%s\n' \
          'cmake_minimum_required(VERSION 3.20)' \
          'project(crossgram_tgcalls_shim_consumer LANGUAGES CXX)' \
          'find_package(CrossgramTgcallsShim CONFIG REQUIRED)' \
          'add_executable(consumer main.cpp)' \
          'target_link_libraries(consumer PRIVATE CrossgramTgcallsShim::crossgram_tgcalls_shim)' \
          > consumer/CMakeLists.txt
        printf '%s\n' \
          '#include <crossgram/tgcalls_shim.h>' \
          'int main(void) {' \
          '  return crossgram_tgcalls_session_create(0, 0, 0, 0, 0, 0, 0) ==' \
          '                 CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT ? 0 : 1;' \
          '}' \
          > consumer/main.cpp
        cmake -S consumer -B consumer-build -G Ninja -DCMAKE_PREFIX_PATH="$out"
        cmake --build consumer-build -j"$NIX_BUILD_CORES"
        ./consumer-build/consumer
        runHook postInstallCheck
      '';
    };

    tgcallsShimStrict = tgcallsShim.overrideAttrs (old: {
      pname = "crossgram-tgcalls-shim-strict";
      preConfigure =
        (old.preConfigure or "")
        + ''
          export CFLAGS="''${CFLAGS:-} -Wall -Wextra -Werror -Wpedantic"
          export CXXFLAGS="''${CXXFLAGS:-} -Wall -Wextra -Werror -Wpedantic"
        '';
    });

    tgcallsShimAsan = tgcallsShim.overrideAttrs (old: {
      pname = "crossgram-tgcalls-shim-asan";
      preConfigure =
        (old.preConfigure or "")
        + ''
          export CXXFLAGS="''${CXXFLAGS:-} -fsanitize=address -fno-omit-frame-pointer"
          export LDFLAGS="''${LDFLAGS:-} -fsanitize=address"
        '';
      checkPhase = ''
        runHook preCheck
        ASAN_OPTIONS=detect_leaks=1 ctest --output-on-failure
        runHook postCheck
      '';
      doInstallCheck = false;
    });

    tgcallsShimTsan = tgcallsShim.overrideAttrs (old: {
      pname = "crossgram-tgcalls-shim-tsan";
      preConfigure =
        (old.preConfigure or "")
        + ''
          export CXXFLAGS="''${CXXFLAGS:-} -fsanitize=thread -fno-omit-frame-pointer"
          export LDFLAGS="''${LDFLAGS:-} -fsanitize=thread"
        '';
      checkPhase = ''
        runHook preCheck
        TSAN_OPTIONS=halt_on_error=1 ctest --output-on-failure
        runHook postCheck
      '';
      doInstallCheck = false;
    });

    corepack = pkgs.writeShellScriptBin "corepack" ''
      exec ${pkgs.corepack}/bin/corepack "$@"
    '';

    yarn = pkgs.writeShellScriptBin "yarn" ''
      exec ${pkgs.corepack}/bin/corepack yarn "$@"
    '';

    buildTools = with pkgs; [
      autoconf
      automake
      binutils
      cargo
      cmake
      gcc
      git
      gnumake
      libtool
      m4
      meson
      nasm
      ninja
      nodejs_24
      patchelf
      perl
      pkg-config
      pnpm
      python312
      rustc
      rustfmt
      clippy
      yasm
    ];

    voiceLibraries = with pkgs; [
      abseil-cpp
      alsa-lib
      dav1d
      dbus
      ffmpeg
      glib
      gobject-introspection
      libdrm
      libevent
      libffi
      libjpeg_turbo
      libunwind
      libvpx
      libxkbcommon
      mesa
      openh264
      openssl
      opus
      pipewire
      protobuf
      pulseaudio
      systemd
      wayland
      wayland-protocols
      zlib
      libx11
      libxcomposite
      libxdamage
      libxext
      libxfixes
      libxrandr
      libxrender
      libxtst
    ];
  in {
    packages.${system} = {
      default = tgcallsArtifact;
      tg-owt = tgOwt;
      tgcalls-artifact = tgcallsArtifact;
      crossgram-tgcalls-shim = tgcallsShim;
      tgcalls-artifact-licenses = tgcallsLicenses;
      tgcalls-artifact-sbom = tgcallsSbom;
    };

    devShells.${system}.default = pkgs.mkShell {
      packages = [corepack yarn] ++ buildTools ++ voiceLibraries;

      LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath voiceLibraries;

      shellHook = ''
        export CARGO_TARGET_DIR="''${CARGO_TARGET_DIR:-$PWD/packages/voice-worker/target}"
        echo "Crossgram voice environment: Node $(node --version), Rust $(rustc --version), CMake $(cmake --version | head -n1), Meson $(meson --version)"
      '';
    };

    checks.${system} = {
      toolchain =
        pkgs.runCommand "crossgram-voice-toolchain-check" {
          nativeBuildInputs = [corepack] ++ buildTools;
        } ''
          node --version
          corepack --version
          pnpm --version
          rustc --version
          cargo --version
          cmake --version
          meson --version
          ninja --version
          cc --version
          touch $out
        '';
      tgcalls-artifact = tgcallsArtifact;
      crossgram-tgcalls-shim = tgcallsShim;
      crossgram-tgcalls-shim-strict = tgcallsShimStrict;
      crossgram-tgcalls-shim-asan = tgcallsShimAsan;
      crossgram-tgcalls-shim-tsan = tgcallsShimTsan;
    };

    formatter.${system} = pkgs.alejandra;
  };
}
