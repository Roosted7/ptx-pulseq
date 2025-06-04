cmake_minimum_required(VERSION 3.5)

add_executable(parsemr
    parsemr.cpp
    ExternalSequence.cpp
    md5.cpp
)

# Include current directory for headers
target_include_directories(parsemr PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
set_target_properties(parsemr PROPERTIES CXX_STANDARD 11 CXX_STANDARD_REQUIRED YES)

# Testing
find_package(Python3 COMPONENTS Interpreter)
if(Python3_EXECUTABLE)
    enable_testing()
    add_test(NAME parser COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/testparser.py)
endif()
