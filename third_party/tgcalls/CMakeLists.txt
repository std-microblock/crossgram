cmake_minimum_required(VERSION 3.22)
project(crossgram_tgcalls_artifact LANGUAGES C CXX)

set(LINUX ON)
set(DESKTOP_APP_USE_PACKAGED ON)
set(DESKTOP_APP_SPECIAL_TARGET OFF)
set(DESKTOP_APP_ENABLE_LTO OFF)
set(third_party_loc "@tgcallsSource@")

add_library(common_options INTERFACE)
add_library(desktop-app::common_options ALIAS common_options)

find_package(PkgConfig REQUIRED)
find_package(tg_owt CONFIG REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(ZLIB REQUIRED)
pkg_check_modules(FFMPEG REQUIRED IMPORTED_TARGET libavcodec libavfilter libavformat libavutil libswresample libswscale)
pkg_check_modules(RNNOISE REQUIRED IMPORTED_TARGET rnnoise)

add_library(external_webrtc INTERFACE)
add_library(desktop-app::external_webrtc ALIAS external_webrtc)
target_link_libraries(external_webrtc INTERFACE tg_owt::tg_owt)

add_library(external_ffmpeg INTERFACE)
add_library(desktop-app::external_ffmpeg ALIAS external_ffmpeg)
target_link_libraries(external_ffmpeg INTERFACE PkgConfig::FFMPEG)

add_library(external_openssl INTERFACE)
add_library(desktop-app::external_openssl ALIAS external_openssl)
target_link_libraries(external_openssl INTERFACE OpenSSL::SSL OpenSSL::Crypto)

add_library(external_rnnoise INTERFACE)
add_library(desktop-app::external_rnnoise ALIAS external_rnnoise)
target_link_libraries(external_rnnoise INTERFACE PkgConfig::RNNOISE tg_owt::tg_owt)

add_library(external_zlib INTERFACE)
add_library(desktop-app::external_zlib ALIAS external_zlib)
target_link_libraries(external_zlib INTERFACE ZLIB::ZLIB)

include("@tdesktopHelpers@/init_target.cmake")
include("@tdesktopHelpers@/nice_target_sources.cmake")
include("@tdesktopHelpers@/target_compile_options_if_exists.cmake")
include("@tdesktopHelpers@/lib_tgcalls.cmake")

add_executable(tgcalls_no_call_probe no_call.cpp)
target_include_directories(tgcalls_no_call_probe PRIVATE "${third_party_loc}/tgcalls")
target_compile_options(lib_tgcalls PRIVATE -ffunction-sections -fdata-sections)
target_compile_options(tgcalls_no_call_probe PRIVATE -ffunction-sections -fdata-sections)
target_link_libraries(tgcalls_no_call_probe PRIVATE
  tg_owt::libabsl
  "$<TARGET_FILE:lib_tgcalls>")
target_link_options(tgcalls_no_call_probe PRIVATE
  -Wl,--gc-sections
  "-Wl,-Map=${CMAKE_CURRENT_BINARY_DIR}/tgcalls_no_call_probe.map")
