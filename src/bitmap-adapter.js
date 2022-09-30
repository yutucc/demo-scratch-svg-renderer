const base64js = require('base64-js');
const md5 = require('js-md5');

/**
 * Adapts Scratch 2.0 bitmaps for use in scratch 3.0
 */
class BitmapAdapter {
    static stageNativeSize = [480, 360]; // render 舞台区域的渲染宽高[width, height]

    static setStageNativeSize(stageNativeSize) {
        if (!Array.isArray(stageNativeSize) || stageNativeSize.length !== 2) {
            return;
        }

        BitmapAdapter.stageNativeSize = stageNativeSize;
    }

    /**
     * @param {?function} makeImage HTML image constructor. Tests can provide this.
     * @param {?function} makeCanvas HTML canvas constructor. Tests can provide this.
     */
    constructor (makeImage, makeCanvas) {
        this._makeImage = makeImage ? makeImage : () => new Image();
        this._makeCanvas = makeCanvas ? makeCanvas : () => document.createElement('canvas');
    }

    /**
     * Return a canvas with the resized version of the given image, done using nearest-neighbor interpolation
     * @param {CanvasImageSource} image The image to resize
     * @param {int} newWidth The desired post-resize width of the image
     * @param {int} newHeight The desired post-resize height of the image
     * @returns {HTMLCanvasElement} A canvas with the resized image drawn on it.
     */
    resize (image, newWidth, newHeight) {
        // We want to always resize using nearest-neighbor interpolation. However, canvas implementations are free to
        // use linear interpolation (or other "smooth" interpolation methods) when downscaling:
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1360415
        // It seems we can get around this by resizing in two steps: first width, then height. This will always result
        // in nearest-neighbor interpolation, even when downscaling.
        const stretchWidthCanvas = this._makeCanvas();
        stretchWidthCanvas.width = newWidth;
        stretchWidthCanvas.height = image.height;
        let context = stretchWidthCanvas.getContext('2d');
        context.imageSmoothingEnabled = false;
        context.drawImage(image, 0, 0, stretchWidthCanvas.width, stretchWidthCanvas.height);
        const stretchHeightCanvas = this._makeCanvas();
        stretchHeightCanvas.width = newWidth;
        stretchHeightCanvas.height = newHeight;
        context = stretchHeightCanvas.getContext('2d');
        context.imageSmoothingEnabled = false;
        context.drawImage(stretchWidthCanvas, 0, 0, stretchHeightCanvas.width, stretchHeightCanvas.height);
        return stretchHeightCanvas;
    }

    /**
     * Scratch 2.0 had resolution 1 and 2 bitmaps. All bitmaps in Scratch 3.0 are equivalent
     * to resolution 2 bitmaps. Therefore, converting a resolution 1 bitmap means doubling
     * it in width and height.
     * @param {!string} dataURI Base 64 encoded image data of the bitmap
     * @param {!function} callback Node-style callback that returns updated dataURI if conversion succeeded
     */
    convertResolution1Bitmap (dataURI, callback) {
        const image = this._makeImage();
        image.src = dataURI;
        image.onload = () => {
            callback(null, this.resize(image, image.width * 2, image.height * 2).toDataURL());
        };
        image.onerror = () => {
            callback('Image load failed');
        };
    }

    /**
     * Given width/height of an uploaded item, return width/height the image will be resized
     * to in Scratch 3.0
     * @param {!number} oldWidth original width
     * @param {!number} oldHeight original height
     * @return {object} Array of new width, new height
     */
    getResizedWidthHeight (oldWidth, oldHeight) {
        const STAGE_WIDTH = 480;
        const STAGE_HEIGHT = 360;
        const STAGE_RATIO = STAGE_WIDTH / STAGE_HEIGHT;

        // If both dimensions are smaller than or equal to corresponding stage dimension,
        // double both dimensions
        if ((oldWidth <= STAGE_WIDTH) && (oldHeight <= STAGE_HEIGHT)) {
            return {width: oldWidth * 2, height: oldHeight * 2};
        }

        // If neither dimension is larger than 2x corresponding stage dimension,
        // this is an in-between image, return it as is
        if ((oldWidth <= STAGE_WIDTH * 2) && (oldHeight <= STAGE_HEIGHT * 2)) {
            return {width: oldWidth, height: oldHeight};
        }

        const imageRatio = oldWidth / oldHeight;
        // Otherwise, figure out how to resize
        if (imageRatio >= STAGE_RATIO) {
            // Wide Image
            return {width: STAGE_WIDTH * 2, height: STAGE_WIDTH * 2 / imageRatio};
        }
        // In this case we have either:
        // - A wide image, but not with as big a ratio between width and height,
        // making it so that fitting the width to double stage size would leave
        // the height too big to fit in double the stage height
        // - A square image that's still larger than the double at least
        // one of the stage dimensions, so pick the smaller of the two dimensions (to fit)
        // - A tall image
        // In any of these cases, resize the image to fit the height to double the stage height
        return {width: STAGE_HEIGHT * 2 * imageRatio, height: STAGE_HEIGHT * 2};
    }

    /**
     * Given bitmap data, resize as necessary.
     * @param {ArrayBuffer | string} fileData Base 64 encoded image data of the bitmap
     * @param {string} fileType The MIME type of this file
     * @returns {Promise} Resolves to resized image data Uint8Array
     */
    importBitmap (fileData, fileType) {
        let dataURI = fileData;
        if (fileData instanceof ArrayBuffer) {
            dataURI = this.convertBinaryToDataURI(fileData, fileType);
        }
        return new Promise((resolve, reject) => {
            const image = this._makeImage();
            image.src = dataURI;
            image.onload = () => {
                const newSize = this.getResizedWidthHeight(image.width, image.height);
                if (newSize.width === image.width && newSize.height === image.height) {
                    // No change
                    resolve(this.convertDataURIToBinary(dataURI));
                } else {
                    const resizedDataURI = this.resize(image, newSize.width, newSize.height).toDataURL();
                    resolve(this.convertDataURIToBinary(resizedDataURI));
                }
            };
            image.onerror = () => {
                reject('Image load failed');
            };
        });
    }

    // TODO consolidate with scratch-vm/src/util/base64-util.js
    // From https://gist.github.com/borismus/1032746
    convertDataURIToBinary (dataURI) {
        const BASE64_MARKER = ';base64,';
        const base64Index = dataURI.indexOf(BASE64_MARKER) + BASE64_MARKER.length;
        const base64 = dataURI.substring(base64Index);
        const raw = window.atob(base64);
        const rawLength = raw.length;
        const array = new Uint8Array(new ArrayBuffer(rawLength));

        for (let i = 0; i < rawLength; i++) {
            array[i] = raw.charCodeAt(i);
        }
        return array;
    }

    convertBinaryToDataURI (arrayBuffer, contentType) {
        return `data:${contentType};base64,${base64js.fromByteArray(new Uint8Array(arrayBuffer))}`;
    }

    /**
     * 获取背景图根据舞台尺寸等比缩放后的新尺寸
     * @param {number} oldWidth 背景图原宽
     * @param {number} oldHeight 背景图原高
     * @param {number} stageWidth 当前舞台的宽（不传则使用当前类设置的值）
     * @param {number} stageHeight 当前舞台的高（不传则使用当前类设置的值）
     * @returns {object} { width, height }
     */
    getBackdropResizedWidthHeight (oldWidth, oldHeight, stageWidth, stageHeight) {
        const STAGE_WIDTH = stageWidth || BitmapAdapter.stageNativeSize[0];
        const STAGE_HEIGHT = stageHeight || BitmapAdapter.stageNativeSize[1];
        const STAGE_RATIO = STAGE_WIDTH / STAGE_HEIGHT;

        const imageRatio = oldWidth / oldHeight;

        if (imageRatio >= STAGE_RATIO) {
            return {
                width: STAGE_HEIGHT * 2 * imageRatio,
                height: STAGE_HEIGHT * 2,
            };
        }

        return {
            width: STAGE_WIDTH * 2,
            height: STAGE_WIDTH * 2 / imageRatio,
        };
    }

    /**
     * 导入背景图时进行的尺寸适配，仿照上面官方的 importBitmap 函数
     * @param {ArrayBuffer | string} fileData Base 64 encoded image data of the bitmap
     * @param {string} fileType The MIME type of this file，比如：image/png
     * @returns {Promise} Resolves to resized image data Uint8Array
     */
    importBackdropBitmap (fileData, fileType) {
        let dataURI = fileData;
        if (fileData instanceof ArrayBuffer) {
            dataURI = this.convertBinaryToDataURI(fileData, fileType);
        }
        return new Promise((resolve, reject) => {
            const image = this._makeImage();
            image.src = dataURI;
            image.onload = () => {
                const newSize = this.getBackdropResizedWidthHeight(image.width, image.height);
                if (newSize.width === image.width && newSize.height === image.height) {
                    // No change
                    resolve(this.convertDataURIToBinary(dataURI));
                } else {
                    const resizedDataURI = this.resize(image, newSize.width, newSize.height).toDataURL();
                    resolve(this.convertDataURIToBinary(resizedDataURI));
                }
            };
            image.onerror = () => {
                reject('Image load failed');
            };
        });
    }

    /**
     * 切换屏幕尺寸时，使用背景图的原图，进行屏幕尺寸适配后，用于更新当前的背景图
     * @param {UInt8Array} assetData storage 中生成的 Asset 对象里面的 data 数据（UInt8Array类型的数据）
     * @param {string} fileType The MIME type of this file，比如：image/png
     * @returns {Promise} ImageData
     */
    changeBackdropBitmap (assetData, fileType) {
        const dataURI = `data:${fileType};base64,${base64js.fromByteArray(assetData)}`;

        return new Promise((resolve, reject) => {
            const image = this._makeImage();
            image.src = dataURI;
            image.onload = () => {
                const newSize = this.getBackdropResizedWidthHeight(image.width, image.height);
                const canvas = this.resize(image, newSize.width, newSize.height);
                const ctx = canvas.getContext('2d');

                resolve(ctx.getImageData(0, 0, newSize.width, newSize.height));
            };
            image.onerror = () => {
                reject('Image load failed');
            };
        });
    }

    /**
     * 将 base64 格式的数据转化成 File 对象
     * @param {string} base64
     * @param {string} dataFormat 文件格式（如：png）
     * @returns {File}
     */
    dataUrlToFile (base64, dataFormat) {
        let arr = base64.split(',');
        let mime = arr[0].match(/:(.*?);/)[1];
        let str = window.atob(arr[1]);
        let n = str.length;
        let u8arr = new Uint8Array(n);

        while (n--) {
            u8arr[n] = str.charCodeAt(n);
        }

        const fileName = md5(u8arr); // 跟 scratch-storage 库中生成 Asset 的 assetId 做法一致

        return new File([u8arr], `${fileName}.${dataFormat}`, { type: mime });
    }

    /**
     * 将背景图的原图适配多个屏幕尺寸比例
     * @param {Object}} originAsset 使用 storage 仓库中的 storage.createAsset 函数生成的背景原图资源对象
     * @param {Array} stageNativeSizes 需要适配的舞台尺寸数组 [{width, height}]
     * @returns {Array} [File] 返回适配好的图片 File 对象，并且把背景图的原图也放在这个数组里面
     */
    adaptiveMoreStageNativeSizeBackdropBitmap (originAsset, stageNativeSizes) {
        const {
            data,
            assetType,
            dataFormat,
        } = originAsset;
        const {
            contentType,
        } = assetType;
        const dataURI = `data:${contentType};base64,${base64js.fromByteArray(data)}`;

        return new Promise((resolve, reject) => {
            const image = this._makeImage();

            image.src = dataURI;
            image.onload = () => {
                const result = [];

                stageNativeSizes.forEach((item) => {
                    const {
                        width,
                        height,
                    } = item;

                    const newSize = this.getBackdropResizedWidthHeight(image.width, image.height, width, height);
                    const canvas = this.resize(image, newSize.width, newSize.height);
                    const img64 = canvas.toDataURL(contentType);
                    const newImgFile = this.dataUrlToFile(img64, dataFormat);

                    result.push(newImgFile);
                });

                result.push(new File([data], `${md5(data)}.${dataFormat}`, { type: contentType })); // 这个是原图

                resolve(result);
            };
            image.onerror = () => {
                reject('Image load failed');
            };
        });
    }
}

module.exports = BitmapAdapter;
