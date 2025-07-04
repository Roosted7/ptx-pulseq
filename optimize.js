// optimize.js
const fs = require('fs').promises;
const path = require('path');
const { glob } = require('glob');
const os = require('os');
let pLimit;
const terser = require('terser');
const postcss = require('postcss');
const cssnano = require('cssnano');
const cheerio = require('cheerio');
const { minify } = require('html-minifier-terser');

// --- Configuration ---
// The minimum number of bytes an optimization must save to be applied.
// This helps prevent tiny optimizations that are outweighed by HTML overhead.
const MIN_SAVINGS_BYTES = 150;

// --- Helper to dynamically import ESM-only imagemin packages ---
async function loadImagemin() {
    const imagemin = (await import('imagemin')).default;
    const imageminGifsicle = (await import('imagemin-gifsicle')).default;
    const imageminJpegtran = (await import('imagemin-jpegtran')).default;
    const imageminPngquant = (await import('imagemin-pngquant')).default;
    const imageminOptipng = (await import('imagemin-optipng')).default;
    const imageminZopfli = (await import('imagemin-zopfli')).default;
    const imageminSvgo = (await import('imagemin-svgo')).default;
    const imageminWebp = (await import('imagemin-webp')).default;
    return { imagemin, imageminGifsicle, imageminJpegtran, imageminPngquant, imageminOptipng, imageminZopfli, imageminSvgo, imageminWebp };
}

const SITE_DIR = 'site';

// --- Helper to check if a file exists ---
async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

// --- Optimization Functions ---

async function minifyJs() {
    if (!pLimit) pLimit = (await import('p-limit')).default;
    console.log('--- Minifying JavaScript files ---');
    const jsFiles = await glob(`${SITE_DIR}/**/*.js`);
    const fmt = (n) => n > 2048 ? `${(n/1024).toFixed(1)}kb` : `${n}b`;
    let totalOriginal = 0, totalSaved = 0;
    const limit = pLimit(os.cpus().length);
    await Promise.all(jsFiles.map(file => limit(async () => {
        try {
            const originalContent = await fs.readFile(file, 'utf8');
            const result = await terser.minify(originalContent);
            if (result.error) {
                console.error(`  Terser error in ${file}:`, result.error);
                return;
            }
            const originalSize = Buffer.byteLength(originalContent, 'utf8');
            const newSize = Buffer.byteLength(result.code, 'utf8');
            const saved = originalSize - newSize;
            const percent = ((saved / originalSize) * 100).toFixed(1);
            totalOriginal += originalSize;
            if (newSize < originalSize) {
                totalSaved += saved;
                console.log(`  Minifying: ${file} (Original: ${fmt(originalSize)}, New: ${fmt(newSize)}, Saved: ${fmt(saved)} [${percent}%])`);
                await fs.writeFile(file, result.code, 'utf8');
            } else {
                console.log(`  Skipping: ${file} (Original: ${fmt(originalSize)}, New: ${fmt(newSize)}, No savings)`);
            }
        } catch (err) {
            console.error(`  Error processing JS file ${file}:`, err.message);
        }
    })));
    if (totalSaved > 0) {
        const percent = ((totalSaved / totalOriginal) * 100).toFixed(1);
        console.log(`  Total JS savings: ${fmt(totalSaved)} / ${fmt(totalOriginal)} [${percent}%]`);
    }
    return { original: totalOriginal, saved: totalSaved };
}

async function minifyCss() {
    if (!pLimit) pLimit = (await import('p-limit')).default;
    console.log('\n--- Minifying CSS files ---');
    const cssFiles = await glob(`${SITE_DIR}/**/*.css`);
    const processor = postcss([cssnano]);
    const fmt = (n) => n > 2048 ? `${(n/1024).toFixed(1)}kb` : `${n}b`;
    let totalOriginal = 0, totalSaved = 0;
    const limit = pLimit(os.cpus().length);
    await Promise.all(cssFiles.map(file => limit(async () => {
        try {
            const originalContent = await fs.readFile(file, 'utf8');
            const cleanContent = originalContent.replace(/\/\*# sourceMappingURL=.*\*\//g, '');
            const result = await processor.process(cleanContent, { from: undefined });
            const originalSize = Buffer.byteLength(originalContent, 'utf8');
            const newSize = Buffer.byteLength(result.css, 'utf8');
            const saved = originalSize - newSize;
            const percent = ((saved / originalSize) * 100).toFixed(1);
            totalOriginal += originalSize;
            if (newSize < originalSize) {
                totalSaved += saved;
                console.log(`  Minifying: ${file} (Original: ${fmt(originalSize)}, New: ${fmt(newSize)}, Saved: ${fmt(saved)} [${percent}%])`);
                await fs.writeFile(file, result.css, 'utf8');
            } else {
                console.log(`  Skipping: ${file} (Original: ${fmt(originalSize)}, New: ${fmt(newSize)}, No savings)`);
            }
        } catch (err) {
            console.error(`  Error processing CSS file ${file}: ${err.message}`);
        }
    })));
    if (totalSaved > 0) {
        const percent = ((totalSaved / totalOriginal) * 100).toFixed(1);
        console.log(`  Total CSS savings: ${fmt(totalSaved)} / ${fmt(totalOriginal)} [${percent}%]`);
    }
    return { original: totalOriginal, saved: totalSaved };
}

async function optimizeImages(imageminTools) {
    if (!pLimit) pLimit = (await import('p-limit')).default;
    const { imagemin, imageminGifsicle, imageminJpegtran, imageminPngquant, imageminOptipng, imageminZopfli, imageminSvgo, imageminWebp } = imageminTools;
    const imageFiles = await glob(`${SITE_DIR}/**/*.{jpg,jpeg,png,gif,svg}`);

    console.log('\n--- Optimizing Images (Lossless) & Generating WebP ---');

    const fmt = (n) => n > 2048 ? `${(n/1024).toFixed(1)}kb` : `${n}b`;
    let totalOriginal = 0, totalSaved = 0;
    const limit = pLimit(os.cpus().length);
    await Promise.all(imageFiles.map(file => limit(async () => {
        try {
            const originalBuffer = await fs.readFile(file);
            const originalSize = originalBuffer.length;
            totalOriginal += originalSize;
            // 1. Perform PNG lossy optimization with pngquant, then lossless with optipng (if PNG)
            let optimizedBuffer = originalBuffer;
            if (/\.png$/i.test(file)) {
                // pngquant (lossy palette reduction), then lossless optipng + zopfli
                let buf = await imagemin.buffer(originalBuffer, {
                    plugins: [imageminPngquant({ quality: [0.7, 0.95], speed: 2 })]
                });
                if (!(buf instanceof Buffer)) {
                    buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
                }
                optimizedBuffer = await imagemin.buffer(buf, {
                    plugins: [
                        imageminOptipng({ optimizationLevel: 7 }),
                        imageminZopfli({ more: true })
                    ]
                });
            } else {
                // Other formats: use existing plugins
                optimizedBuffer = await imagemin.buffer(originalBuffer, {
                    plugins: [
                        imageminGifsicle({ interlaced: true }),
                        imageminJpegtran({ progressive: true }),
                        imageminSvgo()
                    ]
                });
            }
            const newSize = optimizedBuffer.length;
            savings = originalSize - newSize;
            const percent = ((savings / originalSize) * 100).toFixed(1);
            if (newSize < originalSize) {
                console.log(`  Optimizing: ${file} (Original: ${fmt(originalSize)}, New: ${fmt(newSize)}, Saved: ${fmt(savings)} [${percent}%])`);
                await fs.writeFile(file, optimizedBuffer);
            } else {
                console.log(`  Skipping: ${file} (Original: ${fmt(originalSize)}, New: ${fmt(newSize)}, Added ${fmt(-savings)} [${percent}%])`);
                savings = 0; // Reset savings if no optimization
            }
            // 2. Always generate WebP version for PNG and JPG, but only keep if savings > threshold
            let webpSavings = 0;
            if (/\.(jpe?g|png)$/i.test(file)) {
                // Choose the smaller buffer for WebP conversion, and coerce to Buffer
                const rawSource = newSize < originalSize ? optimizedBuffer : originalBuffer;
                // Ensure a Node Buffer: accept Buffer or Uint8Array
                const imageBuffer = Buffer.isBuffer(rawSource)
                    ? rawSource
                    : rawSource instanceof Uint8Array
                        ? Buffer.from(rawSource)
                        : Buffer.from(rawSource.buffer || rawSource);
                const preSize = newSize < originalSize ? newSize : originalSize;
                const webpBuffer = await imagemin.buffer(imageBuffer, {
                    plugins: [imageminWebp({ quality: 85 })]
                });
                const webpPath = file.replace(/\.(jpe?g|png)$/i, '.webp');
                webpSavings = (preSize - webpBuffer.length) || 0;
                if (webpSavings > MIN_SAVINGS_BYTES) {
                    await fs.writeFile(webpPath, webpBuffer);
                    console.log(`  WebP:    ${webpPath} (Saved: ${fmt(webpSavings)} [${((webpSavings/preSize)*100).toFixed(1)}%])`);
                } else {
                    // Remove stale .webp if present
                    try { await fs.unlink(webpPath); } catch {}
                    console.log(`  WebP:    ${webpPath} (Not kept, savings ${fmt(webpSavings)} < ${MIN_SAVINGS_BYTES}b)`);
                    webpSavings = 0; // Reset if not kept
                }
            }
            totalSaved += savings + webpSavings;
            if (webpSavings > 0) {
                console.log(`  Total savings for ${file}: ${fmt(savings + webpSavings)} [${((savings + webpSavings) / originalSize * 100).toFixed(1)}%]`);
            }

        } catch (err) {
            console.error(`  Error optimizing image ${file}:`, err.message);
        }
    })));
    if (totalSaved > 0) {
        const percent = ((totalSaved / totalOriginal) * 100).toFixed(1);
        console.log(`  Total image savings: ${fmt(totalSaved)} / ${fmt(totalOriginal)} [${percent}%]`);
    }
    return { original: totalOriginal, saved: totalSaved };
}


async function processHtml() {
    console.log('\n--- Processing HTML files ---');
    const htmlFiles = await glob(`${SITE_DIR}/**/*.html`);
    for (const file of htmlFiles) {
        try {
            let content = await fs.readFile(file, 'utf8');
            const $ = cheerio.load(content);

            const imagePromises = [];
            $('img').each((i, el) => {
                const img = $(el);
                const originalSrc = img.attr('src');
                if (!originalSrc || originalSrc.startsWith('http') || img.parent().is('picture')) {
                    return;
                }

                const webpSrc = originalSrc.replace(/\.(jpe?g|png)$/i, '.webp');
                const webpPath = path.resolve(path.dirname(file), webpSrc);
                
                imagePromises.push(fileExists(webpPath).then(exists => {
                    if (exists) {
                        const picture = $('<picture></picture>');
                        const source = $('<source>').attr({
                            srcset: webpSrc,
                            type: 'image/webp'
                        });
                        img.wrap(picture);
                        picture.append(source).append(img);
                    }
                }));
            });

            await Promise.all(imagePromises);

            const minifiedHtml = await minify($.html(), {
                collapseWhitespace: true,
                removeComments: true,
                removeRedundantAttributes: true,
                removeScriptTypeAttributes: true,
                removeStyleLinkTypeAttributes: true,
                useShortDoctype: true,
            });
            await fs.writeFile(file, minifiedHtml, 'utf8');
            console.log(`  Processed: ${file}`);

        } catch (err) {
            console.error(`  Error processing HTML file ${file}:`, err.message);
        }
    }
}

// --- Main Execution ---

async function main() {
    console.log('🚀 Starting optimization pipeline...');
    
    const imageminTools = await loadImagemin();
    
    const jsStats = await minifyJs();
    const cssStats = await minifyCss();
    const imgStats = await optimizeImages(imageminTools);
    await processHtml();

    const overallOriginal = jsStats.original + cssStats.original + imgStats.original;
    const overallSaved = jsStats.saved + cssStats.saved + imgStats.saved;
    if (overallSaved > 0) {
        const fmt = (n) => n > 2048 ? `${(n/1024).toFixed(1)}kb` : `${n}b`;
        const percent = ((overallSaved / overallOriginal) * 100).toFixed(1);
        console.log(`\n💡 Overall total savings: ${fmt(overallSaved)} / ${fmt(overallOriginal)} [${percent}%]`);
    }

    console.log('\n✅ Optimization complete!');
}

main().catch(err => {
    console.error('An unhandled error occurred during optimization:', err);
    process.exit(1);
});