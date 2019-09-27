import classNames from 'classnames'
import React from 'react'
import { findDOMNode } from 'react-dom'
import { mat4 } from 'gl-matrix'

import { ExifOrientation, PhotoWork } from 'common/CommonTypes'
import { profileDetailView } from 'common/LogConstants'
import { bindMany } from 'common/util/LangUtil'

import { showError } from 'app/ErrorPresenter'
import { CameraMetrics, CameraMetricsBuilder, RequestedPhotoPosition, PhotoPosition, limitPhotoPosition } from 'app/renderer/CameraMetrics'
import PhotoCanvas from 'app/renderer/PhotoCanvas'
import { Texture } from 'app/renderer/WebGLCanvas'
import { Size } from 'app/UITypes'

import PanZoomController from './PanZoomController'
import TextureCache from './TextureCache'

import './PhotoPane.less'


export interface Props {
    className?: any
    style?: any
    width: number
    height: number
    src: string
    srcPrev: string | null
    srcNext: string | null
    orientation: ExifOrientation
    photoWork: PhotoWork | null
    zoom: number
    setLoading(loading: boolean): void
    onZoomChange(zoom: number, minZoom: number, maxZoom: number): void
}

interface State {
    cameraMetricsBuilder: CameraMetricsBuilder
    prevSrc: string | null
    prevCanvasSize: Size
    textureSize: Size | null
    photoPosition: RequestedPhotoPosition
    cameraMetrics: CameraMetrics
    isDragging: boolean
}

export default class PhotoPane extends React.Component<Props, State> {

    private panZoomController: PanZoomController | undefined = undefined
    private canvas: PhotoCanvas | null = null
    private textureCache: TextureCache | null = null

    private canvasSrc: string | null = null
    private deferredHideCanvasTimeout: NodeJS.Timer | null

    private prevLoading: boolean | null = null
    private prevZoom: number | null = null
    private prevMinZoom: number | null = null


    constructor(props: Props) {
        super(props)
        bindMany(this, 'onPhotoPositionChange', 'onDraggingChange', 'onTextureFetched')
        const cameraMetricsBuilder = new CameraMetricsBuilder()
        this.state = {
            cameraMetricsBuilder,
            prevSrc: null,
            prevCanvasSize: { width: 0, height: 0 },
            textureSize: null,
            photoPosition: 'contain',
            cameraMetrics: cameraMetricsBuilder.getCameraMetrics(),
            isDragging: false,
        }
    }

    static getDerivedStateFromProps(nextProps: Props, prevState: State): Partial<State> | null {
        const { cameraMetricsBuilder } = prevState
        let nextState: Partial<State> | null = null

        let nextPhotoPosition = prevState.photoPosition
        if (nextProps.src !== prevState.prevSrc) {
            nextState = { prevSrc: nextProps.src, textureSize: null, photoPosition: 'contain' }
        } else {
            const prevCameraMetrics = prevState.cameraMetrics
            if (nextProps.zoom !== prevCameraMetrics.photoPosition.zoom) {
                nextPhotoPosition = limitPhotoPosition(prevCameraMetrics, { ...prevCameraMetrics.photoPosition, zoom: nextProps.zoom }, false)
                if (nextPhotoPosition.zoom <= prevCameraMetrics.minZoom) {
                    nextPhotoPosition = 'contain'
                }
                nextState = { photoPosition: nextPhotoPosition }
            }
        }

        if (nextProps.width !== prevState.prevCanvasSize.width || nextProps.height !== prevState.prevCanvasSize.height) {
            const canvasSize = { width: nextProps.width, height: nextProps.height }
            cameraMetricsBuilder.setCanvasSize(canvasSize)
            nextState = { ...nextState, prevCanvasSize: canvasSize }
        }

        if (prevState.textureSize && nextProps.photoWork) {
            const cameraMetrics = cameraMetricsBuilder
                .setTextureSize(prevState.textureSize)
                .setExifOrientation(nextProps.orientation)
                .setPhotoWork(nextProps.photoWork)
                .setPhotoPosition(nextPhotoPosition)
                .getCameraMetrics()
            if (cameraMetrics !== prevState.cameraMetrics) {
                nextState = { ...nextState, cameraMetrics }
            }
        }

        return nextState
    }

    componentDidMount() {
        this.canvas = new PhotoCanvas()
        const canvasElem = this.canvas.getElement()
        canvasElem.className = 'PhotoPane-canvas'
        canvasElem.style.display = 'none'
        const mainElem = findDOMNode(this.refs.main) as HTMLDivElement
        mainElem.appendChild(canvasElem)

        this.panZoomController = new PanZoomController({
            mainElem,
            onPhotoPositionChange: this.onPhotoPositionChange,
            onDraggingChange: this.onDraggingChange,
        })

        this.textureCache = new TextureCache({
            canvas: this.canvas,
            maxCacheSize: 5,
            profile: profileDetailView,
            onTextureFetched: this.onTextureFetched
        })

        this.updateCanvas({}, {})
    }

    componentWillUnmount() {
        if (this.canvas) {
            const canvasElem = this.canvas.getElement()
            canvasElem.parentNode!.removeChild(canvasElem)
            this.canvas = null
        }
        if (this.panZoomController) {
            this.panZoomController.close()
            this.panZoomController = undefined
        }
    }

    componentDidUpdate(prevProps: Props, prevState: State) {
        this.updateCanvas(prevProps, prevState)

        const { photoPosition, minZoom, maxZoom } = this.state.cameraMetrics
        if (photoPosition && (photoPosition.zoom !== this.prevZoom || minZoom !== this.prevMinZoom)) {
            this.prevZoom = photoPosition.zoom
            this.prevMinZoom = minZoom
            this.props.onZoomChange(photoPosition.zoom, minZoom, maxZoom)
        }
    }

    private setLoading(loading: boolean) {
        if (loading !== this.prevLoading) {
            this.prevLoading = loading
            this.props.setLoading(loading)
        }
    }

    private onPhotoPositionChange(photoPosition: PhotoPosition) {
        this.setState({ photoPosition })
    }

    private onDraggingChange(isDragging: boolean) {
        this.setState({ isDragging })
    }

    private onTextureFetched(src: string, texture: Texture | null) {
        if (src === this.props.src && !this.state.textureSize && texture) {
            this.setState({ textureSize: { width: texture.width, height: texture.height } })
        } else {
            this.updateCanvas(this.props, this.state)
        }
    }

    private updateCanvas(prevProps: Partial<Props>, prevState: Partial<State>) {
        const { props, state, canvas, textureCache } = this
        if (!canvas || !textureCache) {
            return
        }

        textureCache.setSourcesToFetch([ props.src, props.srcNext, props.srcPrev ])

        if (textureCache.hasTextureError(props.src)) {
            showError('Showing photo failed: ' + props.src)
            canvas.getElement().style.display = 'none'
            this.setLoading(false)
            return
        }

        let canvasChanged = false

        if (this.canvasSrc !== props.src) {
            let textureToShow = textureCache.getTexture(props.src)
            canvas.setBaseTexture(textureToShow, false)
            this.canvasSrc = textureToShow ? props.src : null
            canvasChanged = true
        }

        if (props.width !== prevProps.width || props.height !== prevProps.height) {
            canvas.setSize({ width: props.width, height: props.height })
            canvasChanged = true
        }

        if (state.cameraMetrics !== prevState.cameraMetrics) {
            canvas
                .setRotationTurns(state.cameraMetrics.rotationTurns)
                .setCameraMatrix(state.cameraMetrics.cameraMatrix)
            canvasChanged = true
        }

        if (canvasChanged && state.textureSize) {
            if (canvas.isValid()) {
                if (this.deferredHideCanvasTimeout) {
                    clearTimeout(this.deferredHideCanvasTimeout)
                    this.deferredHideCanvasTimeout = null
                }
                canvas.update()
                canvas.getElement().style.display = null
                this.setLoading(false)
            } else if (!this.deferredHideCanvasTimeout) {
                // We hide the old image of an invalid canvas with a little delay,
                // in order to avoid blinking if loading the next texture and photo work is fast
                this.deferredHideCanvasTimeout = setTimeout(() => {
                    this.deferredHideCanvasTimeout = null
                    canvas.getElement().style.display = 'none'
                    this.setLoading(true)
                }, 100)
            }
        }

        if (!state.textureSize) {
            const texture = textureCache.getTexture(props.src)
            if (texture) {
                this.setState({ textureSize: { width: texture.width, height: texture.height } })
            }
        }
    }

    render() {
        const { props, state, panZoomController } = this
        if (panZoomController) {
            panZoomController.setProps({ cameraMetrics: state.cameraMetrics })
        }
        return (
            <div
                ref="main"
                className={classNames(props.className, 'PhotoPane', { isZoomed: state.photoPosition !== 'contain', isDragging: state.isDragging })}
                style={{ ...props.style, width: props.width, height: props.height }}
                onWheel={panZoomController && panZoomController.onWheel}
                onMouseDown={panZoomController && panZoomController.onMouseDown}
            />
        )
    }
}
