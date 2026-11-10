//! Granny 2 four-bone skinning over the guest's own memory.
//!
//! The module imports its memory instead of owning one, so the caller hands it
//! the v86 memory and every pointer is `base + guest address`. It keeps no
//! statics and no shadow stack: build.mjs rejects an artifact that carries a
//! data or global section, which is what makes sharing the memory safe.
//!
//! Both entry points return the number of vertices they completed. A short
//! count means the next vertex needs the caller's exact path.

#![no_std]

use core::arch::wasm32::*;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

const PLAIN_HI: f32 = 1073741824.0;
const ENTRY_LO: f32 = 2.117582368135751e-22;
const SCALED_LO: f32 = 4.235164736271502e-22;

#[inline(always)]
unsafe fn load(a: u32) -> v128 {
    v128_load(a as *const v128)
}

#[inline(always)]
unsafe fn rd32(a: u32) -> u32 {
    core::ptr::read_unaligned(a as *const u32)
}

#[inline(always)]
unsafe fn wr32(a: u32, v: u32) {
    core::ptr::write_unaligned(a as *mut u32, v)
}

#[inline(always)]
unsafe fn rd8(a: u32) -> u32 {
    *(a as *const u8) as u32
}

#[inline(always)]
fn xyz(v: v128) -> v128 {
    i32x4_shuffle::<0, 1, 2, 2>(v, v)
}

/// The smallest nonzero magnitude per lane of a matrix whose entries are all zero or
/// within [2^-72, 2^30], and zero lanes otherwise. Magnitudes are compared as integers:
/// the largest decides the upper bound (and rejects NaN), the smallest nonzero one the
/// lower. A lane with nothing but zeros reports +inf, as does the unused fourth lane.
#[inline(always)]
fn plain_matrix(r0: v128, r1: v128, r2: v128, r3: v128) -> v128 {
    let magnitude = u32x4_splat(0x7fff_ffff);
    let one = u32x4_splat(1);
    let b0 = v128_and(r0, magnitude);
    let b1 = v128_and(r1, magnitude);
    let b2 = v128_and(r2, magnitude);
    let b3 = v128_and(r3, magnitude);
    let most = u32x4_max(u32x4_max(b0, b1), u32x4_max(b2, b3));
    let least = i32x4_add(
        u32x4_min(
            u32x4_min(i32x4_sub(b0, one), i32x4_sub(b1, one)),
            u32x4_min(i32x4_sub(b2, one), i32x4_sub(b3, one)),
        ),
        one,
    );
    let ranged = v128_and(f32x4_ge(least, f32x4_splat(ENTRY_LO)), i32x4_le(most, f32x4_splat(PLAIN_HI)));
    let unused = v128_or(i32x4_eq(most, u32x4_splat(0)), i32x4(0, 0, 0, -1));
    v128_bitselect(f32x4_splat(f32::INFINITY), v128_and(least, ranged), unused)
}

/// x87 variant, plain vertices only (see kernel.ts for the bound that makes
/// single-rounded f32 arithmetic equal to precision-control 00). A vertex is plain when
/// its smallest nonzero component times each matrix's smallest nonzero entry is at least
/// 2^-71: the product is rounded, so the test asks for one binade more than the 2^-72 the
/// proof needs. It may send a borderline vertex to the exact path, never one outside the
/// bound to the plain path. Each bone position remembers the matrix it classified last.
#[no_mangle]
pub unsafe extern "C" fn deform_x87(
    base: u32, limit: u32, count: u32, src: u32, dst: u32,
    indices: u32, matrices: u32, tail: u32, c: f32,
) -> u32 {
    let hi = f32x4_splat(PLAIN_HI);
    let lane1 = i32x4(0, -1, 0, 0);
    let mut seen = [u32::MAX; 4];
    let mut floor = [f32x4_splat(0.0); 4];
    let s_stride = 0x20 + 4 * tail;
    let d_stride = 0x18 + 4 * tail;
    let mut s = base.wrapping_add(src);
    let mut d = base.wrapping_add(dst);
    let idx = base.wrapping_add(indices);
    let mut v = 0;
    while v < count {
        let p = xyz(load(s));
        let nraw = load(s + 0x10);
        let n = i32x4_shuffle::<1, 2, 3, 3>(nraw, nraw);
        let pa = f32x4_abs(p);
        let na = f32x4_abs(n);
        if !i32x4_all_true(v128_and(f32x4_le(pa, hi), f32x4_le(na, hi))) {
            return v;
        }
        let inf = f32x4_splat(f32::INFINITY);
        let zero = f32x4_splat(0.0);
        let least = f32x4_pmin(
            v128_bitselect(inf, pa, f32x4_eq(pa, zero)),
            v128_bitselect(inf, na, f32x4_eq(na, zero)),
        );
        let least = f32x4_pmin(least, i32x4_shuffle::<1, 2, 0, 0>(least, least));
        let least = f32x4_pmin(least, i32x4_shuffle::<1, 2, 0, 0>(least, least));
        let vmin = i32x4_shuffle::<0, 0, 0, 0>(least, least);
        let xyx = i32x4_shuffle::<0, 1, 0, 0>(p, p);
        let yxy = i32x4_shuffle::<1, 0, 1, 1>(p, p);
        let z = i32x4_shuffle::<2, 2, 2, 2>(p, p);
        let nxyx = i32x4_shuffle::<0, 1, 0, 0>(n, n);
        let nyxy = i32x4_shuffle::<1, 0, 1, 1>(n, n);
        let nz = i32x4_shuffle::<2, 2, 2, 2>(n, n);
        let mut pos = f32x4_splat(0.0);
        let mut nrm = f32x4_splat(0.0);
        let mut k = 0;
        while k < 4 {
            let mi = rd32(idx.wrapping_add(4 * rd8(s + 0x10 + k)));
            let m = matrices.wrapping_add(mi << 6);
            if limit < 64 || m > limit - 64 {
                return v;
            }
            let mp = base.wrapping_add(m);
            let r0 = load(mp);
            let r1 = load(mp + 16);
            let r2 = load(mp + 32);
            let r3 = load(mp + 48);
            let slot = k as usize;
            if seen[slot] != m {
                floor[slot] = plain_matrix(r0, r1, r2, r3);
                seen[slot] = m;
            }
            if !i32x4_all_true(f32x4_ge(f32x4_mul(floor[slot], vmin), f32x4_splat(SCALED_LO))) {
                return v;
            }
            let w = f32x4_splat(rd8(s + 0x0c + k) as f32 * c);
            let first = v128_bitselect(r1, r0, lane1);
            let second = v128_bitselect(r0, r1, lane1);
            let t = f32x4_mul(
                f32x4_add(f32x4_add(f32x4_add(f32x4_mul(xyx, first), f32x4_mul(z, r2)), f32x4_mul(yxy, second)), r3),
                w,
            );
            let u = f32x4_mul(
                f32x4_add(f32x4_add(f32x4_mul(nxyx, first), f32x4_mul(nz, r2)), f32x4_mul(nyxy, second)),
                w,
            );
            if k == 0 {
                pos = t;
                nrm = u;
            } else {
                pos = f32x4_add(t, pos);
                nrm = f32x4_add(u, nrm);
            }
            k += 1;
        }
        v128_store(d as *mut v128, pos);
        v128_store((d + 8) as *mut v128, i32x4_shuffle::<2, 4, 5, 6>(pos, nrm));
        let mut t = 0;
        while t < tail {
            wr32(d + 0x18 + 4 * t, rd32(s + 0x20 + 4 * t));
            t += 1;
        }
        s = s.wrapping_add(s_stride);
        d = d.wrapping_add(d_stride);
        v += 1;
    }
    count
}

/// SSE variant: every lane is the guest's own packed single-precision operation.
#[no_mangle]
pub unsafe extern "C" fn deform_sse(
    base: u32, limit: u32, count: u32, src: u32, dst: u32, frame: u32, c: f32,
) -> u32 {
    let fp = base.wrapping_add(frame);
    let matrices = rd32(fp + 0x20);
    let idx = base.wrapping_add(rd32(fp + 0x24));
    let mut s = base.wrapping_add(src);
    let mut d = base.wrapping_add(dst);
    let mut v = 0;
    while v < count {
        let p = load(s);
        let nraw = load(s + 0x10);
        let x = i32x4_shuffle::<0, 0, 0, 0>(p, p);
        let y = i32x4_shuffle::<1, 1, 1, 1>(p, p);
        let z = i32x4_shuffle::<2, 2, 2, 2>(p, p);
        let nx = i32x4_shuffle::<1, 1, 1, 1>(nraw, nraw);
        let ny = i32x4_shuffle::<2, 2, 2, 2>(nraw, nraw);
        let nz = i32x4_shuffle::<3, 3, 3, 3>(nraw, nraw);
        let t0 = rd32(s + 0x20);
        let t1 = rd32(s + 0x24);
        let mut pair_p = [f32x4_splat(0.0); 2];
        let mut pair_n = [f32x4_splat(0.0); 2];
        let mut k = 0;
        while k < 4 {
            let mi = rd32(idx.wrapping_add(4 * rd8(s + 0x10 + k)));
            let m = matrices.wrapping_add(mi << 6);
            if limit < 64 || m > limit - 64 {
                return v;
            }
            let mp = base.wrapping_add(m);
            let r0 = load(mp);
            let r1 = load(mp + 16);
            let r2 = load(mp + 32);
            let r3 = load(mp + 48);
            let w = f32x4_splat(rd8(s + 0x0c + k) as f32 * c);
            let pk = f32x4_mul(
                f32x4_add(f32x4_add(f32x4_add(r3, f32x4_mul(x, r0)), f32x4_mul(y, r1)), f32x4_mul(z, r2)),
                w,
            );
            let nk = f32x4_mul(
                f32x4_add(f32x4_add(f32x4_mul(nx, r0), f32x4_mul(ny, r1)), f32x4_mul(nz, r2)),
                w,
            );
            let h = (k >> 1) as usize;
            if k & 1 == 0 {
                pair_p[h] = pk;
                pair_n[h] = nk;
            } else {
                pair_p[h] = f32x4_add(pair_p[h], pk);
                pair_n[h] = f32x4_add(pair_n[h], nk);
            }
            k += 1;
        }
        if v + 1 == count {
            v128_store(fp as *mut v128, pair_p[0]);
            v128_store((fp + 16) as *mut v128, pair_n[0]);
        }
        v128_store(d as *mut v128, f32x4_add(pair_p[1], pair_p[0]));
        v128_store((d + 12) as *mut v128, f32x4_add(pair_n[1], pair_n[0]));
        wr32(d + 0x18, t0);
        wr32(d + 0x1c, t1);
        s = s.wrapping_add(0x28);
        d = d.wrapping_add(0x20);
        v += 1;
    }
    count
}
