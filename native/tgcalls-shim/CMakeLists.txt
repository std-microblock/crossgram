cmake_minimum_required(VERSION 3.20)
project(crossgram_tgcalls_shim LANGUAGES C CXX)

option(CROSSGRAM_TGCALLS_SHIM_BUILD_TESTS "Build standalone PCM bridge tests" ON)

add_library(crossgram_tgcalls_pcm STATIC
  src/pcm_bridge.cpp
  src/session.cpp
  src/tgcalls_shim_pcm.cpp
  src/tgcalls_shim_session.cpp
)
target_compile_features(crossgram_tgcalls_pcm PUBLIC cxx_std_17)
target_include_directories(crossgram_tgcalls_pcm
  PUBLIC include
  PRIVATE src
)

if(CROSSGRAM_TGCALLS_SHIM_BUILD_TESTS)
  enable_testing()
  find_package(Threads REQUIRED)

  add_executable(fake_pcm_test tests/fake_pcm_test.cpp)
  target_link_libraries(fake_pcm_test PRIVATE crossgram_tgcalls_pcm Threads::Threads)
  target_include_directories(fake_pcm_test PRIVATE src)
  add_test(NAME fake_pcm_test COMMAND fake_pcm_test)

  add_executable(fake_session_test tests/fake_session_test.cpp)
  target_link_libraries(fake_session_test PRIVATE crossgram_tgcalls_pcm)
  target_include_directories(fake_session_test PRIVATE src)
  add_test(NAME fake_session_test COMMAND fake_session_test)

  add_executable(c_abi_pcm_test tests/c_abi_pcm_test.c)
  target_link_libraries(c_abi_pcm_test PRIVATE crossgram_tgcalls_pcm)
  add_test(NAME c_abi_pcm_test COMMAND c_abi_pcm_test)

  add_executable(c_abi_session_test tests/c_abi_session_test.c)
  target_link_libraries(c_abi_session_test PRIVATE crossgram_tgcalls_pcm)
  add_test(NAME c_abi_session_test COMMAND c_abi_session_test)

  add_executable(asan_destroy_drain_test tests/asan_destroy_drain_test.cpp)
  target_link_libraries(asan_destroy_drain_test PRIVATE crossgram_tgcalls_pcm Threads::Threads)
  add_test(NAME asan_destroy_drain_test COMMAND asan_destroy_drain_test)

  add_executable(tsan_concurrent_drain_test tests/tsan_concurrent_drain_test.cpp)
  target_link_libraries(tsan_concurrent_drain_test PRIVATE crossgram_tgcalls_pcm Threads::Threads)
  add_test(NAME tsan_concurrent_drain_test COMMAND tsan_concurrent_drain_test)

  add_executable(tsan_session_callback_stop_join_test tests/tsan_session_callback_stop_join_test.cpp)
  target_link_libraries(tsan_session_callback_stop_join_test PRIVATE crossgram_tgcalls_pcm Threads::Threads)
  target_include_directories(tsan_session_callback_stop_join_test PRIVATE src)
  add_test(NAME tsan_session_callback_stop_join_test COMMAND tsan_session_callback_stop_join_test)
endif()
