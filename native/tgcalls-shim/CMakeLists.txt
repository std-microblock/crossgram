cmake_minimum_required(VERSION 3.20)
project(crossgram_tgcalls_shim LANGUAGES C CXX)

include(CMakePackageConfigHelpers)
include(GNUInstallDirs)

option(CROSSGRAM_TGCALLS_SHIM_BUILD_TESTS "Build standalone PCM bridge tests" ON)
option(CROSSGRAM_TGCALLS_SHIM_ENABLE_ARTIFACT "Enable the pinned tgcalls session adapter" OFF)
option(CROSSGRAM_TGCALLS_SHIM_BUILD_SHARED "Build the C ABI shim as a shared library" OFF)
set(CROSSGRAM_TGCALLS_ARTIFACT_ROOT "" CACHE PATH "Pinned tgcalls artifact installation root")

set(CROSSGRAM_TGCALLS_SHIM_SOURCES
  src/pcm_bridge.cpp
  src/pinned_transport_policy.cpp
  src/session.cpp
  src/tgcalls_shim_pcm.cpp
  src/tgcalls_shim_session.cpp
)

set(CROSSGRAM_TGCALLS_SHIM_LIBRARY_TYPE STATIC)
if(CROSSGRAM_TGCALLS_SHIM_BUILD_SHARED)
  set(CROSSGRAM_TGCALLS_SHIM_LIBRARY_TYPE SHARED)
endif()
add_library(crossgram_tgcalls_shim ${CROSSGRAM_TGCALLS_SHIM_LIBRARY_TYPE} ${CROSSGRAM_TGCALLS_SHIM_SOURCES})
target_compile_features(crossgram_tgcalls_shim PUBLIC cxx_std_17)
target_include_directories(crossgram_tgcalls_shim
  PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
  PRIVATE src
)

if(CROSSGRAM_TGCALLS_SHIM_BUILD_SHARED AND UNIX AND
   CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(crossgram_tgcalls_shim PRIVATE -fvisibility=hidden)
  target_link_options(crossgram_tgcalls_shim PRIVATE
    "-Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/cmake/crossgram_tgcalls_shim.map")
endif()

if(CROSSGRAM_TGCALLS_SHIM_ENABLE_ARTIFACT)
  if(NOT CROSSGRAM_TGCALLS_ARTIFACT_ROOT)
    message(FATAL_ERROR "CROSSGRAM_TGCALLS_ARTIFACT_ROOT is required when enabling tgcalls")
  endif()

  find_package(PkgConfig REQUIRED)
  find_package(tg_owt CONFIG REQUIRED)
  find_package(OpenSSL REQUIRED)
  find_package(ZLIB REQUIRED)
  pkg_check_modules(FFMPEG REQUIRED IMPORTED_TARGET libavcodec libavfilter libavformat libavutil libswresample libswscale)
  pkg_check_modules(RNNOISE REQUIRED IMPORTED_TARGET rnnoise)

  add_library(crossgram_tgcalls_artifact STATIC IMPORTED GLOBAL)
  set_target_properties(crossgram_tgcalls_artifact PROPERTIES
    IMPORTED_LOCATION "${CROSSGRAM_TGCALLS_ARTIFACT_ROOT}/lib/liblib_tgcalls.a"
    INTERFACE_INCLUDE_DIRECTORIES "${CROSSGRAM_TGCALLS_ARTIFACT_ROOT}/include")

  target_sources(crossgram_tgcalls_shim PRIVATE src/tgcalls_production_adapter.cpp)
  target_compile_definitions(crossgram_tgcalls_shim PRIVATE CROSSGRAM_TGCALLS_SHIM_HAVE_TGCALLS=1)
  if(CROSSGRAM_TGCALLS_SHIM_BUILD_TESTS)
    target_compile_definitions(crossgram_tgcalls_shim PRIVATE CROSSGRAM_TGCALLS_SHIM_TESTING=1)
  endif()
  target_link_libraries(crossgram_tgcalls_shim PUBLIC
    crossgram_tgcalls_artifact
    tg_owt::tg_owt
    tg_owt::libabsl
    PkgConfig::FFMPEG
    PkgConfig::RNNOISE
    OpenSSL::SSL
    OpenSSL::Crypto
    ZLIB::ZLIB)
endif()

set(CROSSGRAM_TGCALLS_SHIM_TEST_TARGET crossgram_tgcalls_shim)
if(CROSSGRAM_TGCALLS_SHIM_BUILD_TESTS AND CROSSGRAM_TGCALLS_SHIM_BUILD_SHARED)
  add_library(crossgram_tgcalls_shim_test_support STATIC ${CROSSGRAM_TGCALLS_SHIM_SOURCES})
  target_compile_features(crossgram_tgcalls_shim_test_support PUBLIC cxx_std_17)
  target_include_directories(crossgram_tgcalls_shim_test_support
    PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    PRIVATE src)
  if(CROSSGRAM_TGCALLS_SHIM_ENABLE_ARTIFACT)
    target_sources(crossgram_tgcalls_shim_test_support PRIVATE src/tgcalls_production_adapter.cpp)
    target_compile_definitions(crossgram_tgcalls_shim_test_support PRIVATE
      CROSSGRAM_TGCALLS_SHIM_HAVE_TGCALLS=1
      CROSSGRAM_TGCALLS_SHIM_TESTING=1)
    target_link_libraries(crossgram_tgcalls_shim_test_support PUBLIC
      crossgram_tgcalls_artifact
      tg_owt::tg_owt
      tg_owt::libabsl
      PkgConfig::FFMPEG
      PkgConfig::RNNOISE
      OpenSSL::SSL
      OpenSSL::Crypto
      ZLIB::ZLIB)
  endif()
  set(CROSSGRAM_TGCALLS_SHIM_TEST_TARGET crossgram_tgcalls_shim_test_support)
endif()

install(TARGETS crossgram_tgcalls_shim
  EXPORT CrossgramTgcallsShimTargets
  ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
  LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR})
install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
configure_package_config_file(
  cmake/CrossgramTgcallsShimConfig.cmake.in
  ${CMAKE_CURRENT_BINARY_DIR}/CrossgramTgcallsShimConfig.cmake
  INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/CrossgramTgcallsShim)
write_basic_package_version_file(
  ${CMAKE_CURRENT_BINARY_DIR}/CrossgramTgcallsShimConfigVersion.cmake
  VERSION 1.0.0
  COMPATIBILITY SameMajorVersion)
install(FILES
  ${CMAKE_CURRENT_BINARY_DIR}/CrossgramTgcallsShimConfig.cmake
  ${CMAKE_CURRENT_BINARY_DIR}/CrossgramTgcallsShimConfigVersion.cmake
  DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/CrossgramTgcallsShim)
install(EXPORT CrossgramTgcallsShimTargets
  FILE CrossgramTgcallsShimTargets.cmake
  NAMESPACE CrossgramTgcallsShim::
  DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/CrossgramTgcallsShim)

if(CROSSGRAM_TGCALLS_SHIM_BUILD_TESTS)
  enable_testing()
  find_package(Threads REQUIRED)

  add_executable(fake_pcm_test tests/fake_pcm_test.cpp)
  target_link_libraries(fake_pcm_test PRIVATE ${CROSSGRAM_TGCALLS_SHIM_TEST_TARGET} Threads::Threads)
  target_include_directories(fake_pcm_test PRIVATE src)
  add_test(NAME fake_pcm_test COMMAND fake_pcm_test)

  add_executable(fake_session_test tests/fake_session_test.cpp)
  target_link_libraries(fake_session_test PRIVATE ${CROSSGRAM_TGCALLS_SHIM_TEST_TARGET})
  target_include_directories(fake_session_test PRIVATE src)
  add_test(NAME fake_session_test COMMAND fake_session_test)

  add_executable(pinned_transport_policy_test tests/pinned_transport_policy_test.cpp)
  target_link_libraries(pinned_transport_policy_test PRIVATE ${CROSSGRAM_TGCALLS_SHIM_TEST_TARGET})
  target_include_directories(pinned_transport_policy_test PRIVATE src)
  add_test(NAME pinned_transport_policy_test COMMAND pinned_transport_policy_test)

  add_executable(c_abi_pcm_test tests/c_abi_pcm_test.c)
  target_link_libraries(c_abi_pcm_test PRIVATE ${CROSSGRAM_TGCALLS_SHIM_TEST_TARGET})
  add_test(NAME c_abi_pcm_test COMMAND c_abi_pcm_test)

  if(NOT CROSSGRAM_TGCALLS_SHIM_ENABLE_ARTIFACT)
    add_executable(c_abi_session_test tests/c_abi_session_test.c)
    target_link_libraries(c_abi_session_test PRIVATE ${CROSSGRAM_TGCALLS_SHIM_TEST_TARGET})
    add_test(NAME c_abi_session_test COMMAND c_abi_session_test)
  endif()

  add_executable(asan_destroy_drain_test tests/asan_destroy_drain_test.cpp)
  target_link_libraries(asan_destroy_drain_test PRIVATE ${CROSSGRAM_TGCALLS_SHIM_TEST_TARGET} Threads::Threads)
  add_test(NAME asan_destroy_drain_test COMMAND asan_destroy_drain_test)

  add_executable(tsan_concurrent_drain_test tests/tsan_concurrent_drain_test.cpp)
  target_link_libraries(tsan_concurrent_drain_test PRIVATE ${CROSSGRAM_TGCALLS_SHIM_TEST_TARGET} Threads::Threads)
  add_test(NAME tsan_concurrent_drain_test COMMAND tsan_concurrent_drain_test)

  add_executable(tsan_session_callback_stop_join_test tests/tsan_session_callback_stop_join_test.cpp)
  target_link_libraries(tsan_session_callback_stop_join_test PRIVATE ${CROSSGRAM_TGCALLS_SHIM_TEST_TARGET} Threads::Threads)
  target_include_directories(tsan_session_callback_stop_join_test PRIVATE src)
  add_test(NAME tsan_session_callback_stop_join_test COMMAND tsan_session_callback_stop_join_test)

  if(CROSSGRAM_TGCALLS_SHIM_ENABLE_ARTIFACT)
    add_executable(artifact_session_parameter_test tests/artifact_session_construction_test.c)
    target_link_libraries(artifact_session_parameter_test PRIVATE ${CROSSGRAM_TGCALLS_SHIM_TEST_TARGET})
    add_test(NAME artifact_session_parameter_test COMMAND artifact_session_parameter_test)

    add_executable(artifact_direct_p2p_test tests/artifact_direct_p2p_test.cpp)
    target_link_libraries(artifact_direct_p2p_test PRIVATE ${CROSSGRAM_TGCALLS_SHIM_TEST_TARGET})
    target_include_directories(artifact_direct_p2p_test PRIVATE src)
    target_compile_definitions(artifact_direct_p2p_test PRIVATE CROSSGRAM_TGCALLS_SHIM_TESTING=1)
    add_test(NAME artifact_direct_p2p_test COMMAND artifact_direct_p2p_test)

    add_executable(artifact_teardown_barrier_test tests/artifact_teardown_barrier_test.cpp)
    target_link_libraries(artifact_teardown_barrier_test PRIVATE ${CROSSGRAM_TGCALLS_SHIM_TEST_TARGET})
    add_test(NAME artifact_teardown_barrier_test COMMAND artifact_teardown_barrier_test)
  endif()
endif()
