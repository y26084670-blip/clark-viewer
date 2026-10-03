#!/usr/bin/env python3
"""Optional Linux/Mesa real GLSL compilation and offscreen rendering check.

Usage: python3 scripts/verify-volume-rendering.py
Requires installed npm dependencies, Node.js, Python3, libEGL.so.1 and a
surfaceless EGL OpenGL ES3 driver (Mesa llvmpipe works; no display/browser).
This deliberately is not part of npm test. Missing optional dependencies and
failed GPU assertions both produce JSON status=fail and a nonzero exit code.
See docs/AI_3D_RENDERING.md for coverage and limitations.
"""
import ctypes as C
import json
import os
from pathlib import Path
import subprocess
import sys


def run():
    os.environ.setdefault("LIBGL_ALWAYS_SOFTWARE", "1")
    os.environ.setdefault("MESA_SHADER_CACHE_DISABLE", "true")
    exporter = Path(__file__).with_name("export-volume-rendering.mjs")
    exported = subprocess.run([os.environ.get("NODE", "node"), str(exporter)],
                              capture_output=True, text=True, check=False)
    if exported.returncode:
        raise RuntimeError("Shader export failed: " + exported.stderr.strip())
    source = json.loads(exported.stdout)
    egl = C.CDLL("libEGL.so.1")
    egl.eglGetProcAddress.argtypes = [C.c_char_p]
    egl.eglGetProcAddress.restype = C.c_void_p

    def api(name, result, args):
        pointer = egl.eglGetProcAddress(name.encode())
        if not pointer:
            raise RuntimeError("EGL/OpenGL ES function unavailable: " + name)
        return C.CFUNCTYPE(result, *args)(pointer)

    uint, integer, floating, pointer = C.c_uint, C.c_int, C.c_float, C.c_void_p
    display = api("eglGetPlatformDisplayEXT", pointer, [uint, pointer, C.POINTER(integer)])(0x31DD, None, None)
    major, minor = integer(), integer()
    if not api("eglInitialize", uint, [pointer, C.POINTER(integer), C.POINTER(integer)])(display, C.byref(major), C.byref(minor)):
        raise RuntimeError("Surfaceless EGL initialization failed")
    if not api("eglBindAPI", uint, [uint])(0x30A0):
        raise RuntimeError("OpenGL ES API unavailable")
    attributes = (integer * 15)(0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8,
                                0x3033, 1, 0x3040, 0x0040, 0x3025, 24, 0x3038)
    config, count = pointer(), integer()
    choose = api("eglChooseConfig", uint, [pointer, C.POINTER(integer), C.POINTER(pointer), integer, C.POINTER(integer)])
    if not choose(display, attributes, C.byref(config), 1, C.byref(count)) or not count.value:
        raise RuntimeError("EGL ES3 RGBA8 pbuffer configuration unavailable")
    context = api("eglCreateContext", pointer, [pointer, pointer, pointer, C.POINTER(integer)])(
        display, config, None, (integer * 3)(0x3098, 3, 0x3038))
    surface = api("eglCreatePbufferSurface", pointer, [pointer, pointer, C.POINTER(integer)])(
        display, config, (integer * 5)(0x3057, 32, 0x3056, 32, 0x3038))
    if not context or not surface or not api("eglMakeCurrent", uint, [pointer, pointer, pointer, pointer])(display, surface, surface, context):
        raise RuntimeError("EGL offscreen ES3 context creation failed")

    specifications = {
        "GetString": (C.c_char_p, [uint]), "GetError": (uint, []),
        "CreateShader": (uint, [uint]), "ShaderSource": (None, [uint, integer, C.POINTER(C.c_char_p), C.POINTER(integer)]),
        "CompileShader": (None, [uint]), "GetShaderiv": (None, [uint, uint, C.POINTER(integer)]),
        "GetShaderInfoLog": (None, [uint, integer, C.POINTER(integer), pointer]),
        "CreateProgram": (uint, []), "AttachShader": (None, [uint, uint]), "LinkProgram": (None, [uint]),
        "GetProgramiv": (None, [uint, uint, C.POINTER(integer)]), "GetProgramInfoLog": (None, [uint, integer, C.POINTER(integer), pointer]),
        "UseProgram": (None, [uint]), "GetUniformLocation": (integer, [uint, C.c_char_p]),
        "Uniform1i": (None, [integer, integer]), "Uniform1f": (None, [integer, floating]),
        "Uniform3f": (None, [integer, floating, floating, floating]), "Uniform4f": (None, [integer, floating, floating, floating, floating]),
        "UniformMatrix4fv": (None, [integer, integer, uint, C.POINTER(floating)]),
        "GenTextures": (None, [integer, C.POINTER(uint)]), "BindTexture": (None, [uint, uint]), "ActiveTexture": (None, [uint]),
        "TexParameteri": (None, [uint, uint, integer]), "TexImage2D": (None, [uint, integer, integer, integer, integer, integer, uint, uint, pointer]),
        "TexImage3D": (None, [uint, integer, integer, integer, integer, integer, integer, uint, uint, pointer]),
        "GenVertexArrays": (None, [integer, C.POINTER(uint)]), "BindVertexArray": (None, [uint]),
        "GenBuffers": (None, [integer, C.POINTER(uint)]), "BindBuffer": (None, [uint, uint]),
        "BufferData": (None, [uint, C.c_ssize_t, pointer, uint]), "GetAttribLocation": (integer, [uint, C.c_char_p]),
        "EnableVertexAttribArray": (None, [uint]), "VertexAttribPointer": (None, [uint, integer, uint, uint, integer, pointer]),
        "Viewport": (None, [integer, integer, integer, integer]), "ClearColor": (None, [floating, floating, floating, floating]),
        "Clear": (None, [uint]), "Enable": (None, [uint]), "CullFace": (None, [uint]),
        "DrawArrays": (None, [uint, integer, integer]), "ReadPixels": (None, [integer, integer, integer, integer, uint, uint, pointer]),
    }
    gl = {name: api("gl" + name, result, args) for name, (result, args) in specifications.items()}
    program = gl["CreateProgram"]()
    for kind, name in [(0x8B31, "vertex"), (0x8B30, "fragment")]:
        shader = gl["CreateShader"](kind)
        text = C.c_char_p(source[name].encode())
        gl["ShaderSource"](shader, 1, C.byref(text), None)
        gl["CompileShader"](shader)
        status, log = integer(), C.create_string_buffer(16000)
        gl["GetShaderiv"](shader, 0x8B81, C.byref(status))
        gl["GetShaderInfoLog"](shader, len(log), None, log)
        if not status.value:
            raise RuntimeError(name + " compilation failed: " + log.value.decode())
        gl["AttachShader"](program, shader)
    gl["LinkProgram"](program)
    status, log = integer(), C.create_string_buffer(16000)
    gl["GetProgramiv"](program, 0x8B82, C.byref(status))
    gl["GetProgramInfoLog"](program, len(log), None, log)
    if not status.value:
        raise RuntimeError("Shader link failed: " + log.value.decode())
    gl["UseProgram"](program)

    def uniform(name):
        return gl["GetUniformLocation"](program, name.encode())

    for index, (target, name) in enumerate([(0x806F, "uField"), (0x0DE1, "uPalette")]):
        texture = uint()
        gl["GenTextures"](1, C.byref(texture))
        gl["ActiveTexture"](0x84C0 + index)
        gl["BindTexture"](target, texture.value)
        for parameter in [0x2801, 0x2800]:
            gl["TexParameteri"](target, parameter, 0x2601)
        for parameter in [0x2802, 0x2803] + ([0x8072] if index == 0 else []):
            gl["TexParameteri"](target, parameter, 0x812F)
        gl["Uniform1i"](uniform(name), index)

    def set_field(value=128, mask=255):
        gl["ActiveTexture"](0x84C0)
        data = (C.c_ubyte * 32)(*([value, 0, 0, mask] * 8))
        gl["TexImage3D"](0x806F, 0, 0x8058, 2, 2, 2, 0, 0x1908, 0x1401, data)

    def set_palette(data, color_space="srgb"):
        gl["ActiveTexture"](0x84C1)
        # Three maps SRGBColorSpace + RGBA + UnsignedByte to SRGB8_ALPHA8.
        internal_format = 0x8C43 if color_space == "srgb" else 0x8058
        gl["TexImage2D"](0x0DE1, 0, internal_format, 256, 1, 0, 0x1908, 0x1401, (C.c_ubyte * len(data))(*data))

    array, buffer = uint(), uint()
    gl["GenVertexArrays"](1, C.byref(array))
    gl["BindVertexArray"](array.value)
    gl["GenBuffers"](1, C.byref(buffer))
    gl["BindBuffer"](0x8892, buffer.value)
    vertices = (floating * len(source["positions"]))(*source["positions"])
    gl["BufferData"](0x8892, C.sizeof(vertices), vertices, 0x88E4)
    position = gl["GetAttribLocation"](program, b"position")
    gl["EnableVertexAttribArray"](position)
    gl["VertexAttribPointer"](position, 3, 0x1406, 0, 0, None)
    gl["Viewport"](0, 0, 32, 32)
    gl["Uniform4f"](uniform("uViewport"), 0, 0, 32, 32)
    gl["Uniform3f"](uniform("uDimensions"), 2, 2, 2)
    gl["Uniform3f"](uniform("uWorldSize"), 1, 1, 1)
    gl["Enable"](0x0B44)
    gl["CullFace"](0x0404)  # Production BackSide proxy cube.
    gl["Enable"](0x0B71)
    renders = 0

    def render(camera, opacity):
        nonlocal renders
        for name, key in [("projectionMatrix", "projection"), ("modelViewMatrix", "modelView"), ("uClipToLocal", "clipToLocal")]:
            gl["UniformMatrix4fv"](uniform(name), 1, 0, (floating * 16)(*camera[key]))
        gl["Uniform1f"](uniform("uOpacity"), opacity)
        gl["ClearColor"](0, 0, 0, 0)
        gl["Clear"](0x4000 | 0x0100)
        gl["DrawArrays"](0x0004, 0, len(source["positions"]) // 3)
        pixels = (C.c_ubyte * (32 * 32 * 4))()
        gl["ReadPixels"](0, 0, 32, 32, 0x1908, 0x1401, pixels)
        error = gl["GetError"]()
        if error:
            raise RuntimeError("OpenGL ES error: " + hex(error))
        renders += 1
        return list(pixels[(16 * 32 + 16) * 4:(16 * 32 + 16) * 4 + 4]), pixels

    def require(condition, message):
        if not condition:
            raise RuntimeError(message)

    set_field()
    set_palette([255, 0, 0, 255] * 256)
    for camera in source["cameras"]:
        for opacity in [0, 0.25, 0.5, 1]:
            center, pixels = render(camera, opacity)
            expected = round(255 * (1 - max(0.001, 1 - opacity) ** camera["centerPathLength"]))
            require(abs(center[3] - expected) <= 2,
                    f"{camera['name']} opacity={opacity}: alpha {center[3]}, expected {expected}")
            if opacity == 0:
                require(not any(pixels), "Zero opacity produced visible fragments")
            else:
                require(center[:3] == [255, 0, 0], "Constant-color volume changed hue")
    camera = source["cameras"][0]
    set_field(0, 0)
    _, pixels = render(camera, 1)
    require(not any(pixels), "Empty mask produced visible fragments")
    set_field(64, 128)
    center, _ = render(camera, 0.5)
    expected = round(255 * (1 - 0.5 ** (128 / 255)))
    require(abs(center[3] - expected) <= 2, "Partial mask did not scale optical density")

    def srgb(value):
        return 255 * (value * 12.92 if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055)

    for palette in source["palettes"]:
        set_palette(palette["bytes"], palette["colorSpace"])
        for scalar in [0, 128, 255]:
            set_field(scalar)
            center, _ = render(camera, 0.5)
            raw = palette["bytes"][scalar * 4:scalar * 4 + 3]
            expected = raw if palette["colorSpace"] == "srgb" else [srgb(value / 255) for value in raw]
            require(all(abs(center[i] - expected[i]) <= 3 for i in range(3)),
                    f"{palette['name']} scalar={scalar}: palette/color-space mismatch {center[:3]}")
    return {"status": "pass", "egl": f"{major.value}.{minor.value}",
            "renderer": gl["GetString"](0x1F01).decode(), "gl": gl["GetString"](0x1F02).decode(),
            "compileLink": "pass", "offscreenRenders": renders,
            "cameras": [item["name"] for item in source["cameras"]],
            "palettes": [item["name"] for item in source["palettes"]]}


if __name__ == "__main__":
    try:
        print(json.dumps(run(), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"status": "fail", "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
