
import * as BRRES from './brres';

import * as GX_Material from '../gx/gx_material';
import { mat4, vec3 } from "gl-matrix";
import { MaterialParams, GXTextureHolder, ColorKind, translateTexFilterGfx, translateWrapModeGfx, PacketParams, ub_MaterialParams, u_MaterialParamsBufferSize, fillMaterialParamsData, loadedDataCoalescerComboGfx } from "../gx/gx_render";
import { GXRenderHelperGfx, GXShapeHelperGfx, GXMaterialHelperGfx } from "../gx/gx_render_2";
import { computeViewMatrix, computeViewMatrixSkybox, Camera, computeViewSpaceDepthFromWorldSpaceAABB } from "../Camera";
import AnimationController from "../AnimationController";
import { TextureMapping } from "../TextureHolder";
import { IntersectionState, AABB } from "../Geometry";
import { GfxDevice, GfxSampler } from "../gfx/platform/GfxPlatform";
import { ViewerRenderInput } from "../viewer";
import { GfxRendererLayer, makeSortKey, setSortKeyDepth, setSortKeyBias } from "../gfx/render/GfxRenderer";
import { GfxBufferCoalescer, GfxBufferCoalescerCombo } from '../gfx/helpers/BufferHelpers';
import { nArray } from '../util';
import { prepareFrameDebugOverlayCanvas2D, getDebugOverlayCanvas2D, drawWorldSpaceLine } from '../DebugJunk';
import { colorCopy } from '../Color';
import { computeNormalMatrix, texProjPerspMtx, texEnvMtx } from '../MathHelpers';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache';
import { GfxRenderInst, GfxRenderInstManager } from '../gfx/render/GfxRenderer2';
import { arrayCopy } from '../gfx/platform/GfxPlatformUtil';

export class RRESTextureHolder extends GXTextureHolder<BRRES.TEX0> {
    public addRRESTextures(device: GfxDevice, rres: BRRES.RRES): void {
        this.addTextures(device, rres.tex0);
    }
}

export class MDL0Model {
    public shapeData: GXShapeHelperGfx[] = [];
    public materialData: MaterialData[] = [];
    private bufferCoalescer: GfxBufferCoalescerCombo;

    constructor(device: GfxDevice, cache: GfxRenderCache, public mdl0: BRRES.MDL0, private materialHacks: GX_Material.GXMaterialHacks | null = null) {
        this.bufferCoalescer = loadedDataCoalescerComboGfx(device, this.mdl0.shapes.map((shape) => shape.loadedVertexData));
 
        for (let i = 0; i < this.mdl0.shapes.length; i++) {
            const shape = this.mdl0.shapes[i];
            this.shapeData[i] = new GXShapeHelperGfx(device, cache, this.bufferCoalescer.coalescedBuffers[i], shape.loadedVertexLayout, shape.loadedVertexData);
        }

        for (let i = 0; i < this.mdl0.materials.length; i++) {
            const material = this.mdl0.materials[i];
            this.materialData[i] = new MaterialData(device, material, this.materialHacks);
        }
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.shapeData.length; i++)
            this.shapeData[i].destroy(device);
        for (let i = 0; i < this.materialData.length; i++)
            this.materialData[i].destroy(device);
        this.bufferCoalescer.destroy(device);
    }
}

const bboxScratch = new AABB();
const packetParams = new PacketParams();
class ShapeInstance {
    public sortKeyBias = 0;

    constructor(public shape: BRRES.MDL0_ShapeEntry, public shapeData: GXShapeHelperGfx, public sortVizNode: BRRES.MDL0_NodeEntry, public materialInstance: MaterialInstance) {
    }

    private computeModelView(dst: mat4, modelMatrix: mat4, camera: Camera, isSkybox: boolean): void {
        if (isSkybox) {
            computeViewMatrixSkybox(dst, camera);
        } else {
            computeViewMatrix(dst, camera);
        }

        mat4.mul(dst, dst, modelMatrix);
    }

    public prepareToRender(device: GfxDevice, textureHolder: GXTextureHolder, renderInstManager: GfxRenderInstManager, depth: number, camera: Camera, modelMatrix: mat4, instanceStateData: InstanceStateData, isSkybox: boolean): void {
        const materialInstance = this.materialInstance;

        const template = renderInstManager.pushTemplateRenderInst();
        template.sortKey = materialInstance.sortKey;
        template.sortKey = setSortKeyDepth(template.sortKey, depth);
        template.sortKey = setSortKeyBias(template.sortKey, this.sortKeyBias);

        materialInstance.setOnRenderInst(device, renderInstManager.gfxRenderCache, template);

        template.allocateUniformBuffer(ub_MaterialParams, u_MaterialParamsBufferSize);
        materialInstance.fillMaterialParams(template, textureHolder, instanceStateData, modelMatrix, camera);

        packetParams.clear();
        for (let p = 0; p < this.shape.loadedVertexData.packets.length; p++) {
            const packet = this.shape.loadedVertexData.packets[p];

            let instVisible = false;
            if (this.shape.mtxIdx < 0) {
                for (let j = 0; j < packet.posNrmMatrixTable.length; j++) {
                    const mtxIdx = packet.posNrmMatrixTable[j];

                    // Leave existing matrix.
                    if (mtxIdx === 0xFFFF)
                        continue;

                    this.computeModelView(packetParams.u_PosMtx[j], instanceStateData.matrixArray[mtxIdx], camera, isSkybox);

                    if (instanceStateData.matrixVisibility[j] !== IntersectionState.FULLY_OUTSIDE)
                        instVisible = true;
                }
            } else {
                instVisible = true;
                this.computeModelView(packetParams.u_PosMtx[0], instanceStateData.matrixArray[this.shape.mtxIdx], camera, isSkybox);
            }

            if (!instVisible)
                continue;

            const renderInst = this.shapeData.pushRenderInst(renderInstManager, packet);
            this.shapeData.fillPacketParams(packetParams, renderInst);
        }
        renderInstManager.popTemplateRenderInst();
    }
}

function mat4SwapTranslationColumns(m: mat4): void {
    const tx = m[12];
    m[12] = m[8];
    m[8] = tx;
    const ty = m[13];
    m[13] = m[9];
    m[9] = ty;
}

function colorChannelCopy(o: GX_Material.ColorChannelControl): GX_Material.ColorChannelControl {
    return Object.assign({}, o);
}

function lightChannelCopy(o: GX_Material.LightChannelControl): GX_Material.LightChannelControl {
    const colorChannel = colorChannelCopy(o.colorChannel);
    const alphaChannel = colorChannelCopy(o.alphaChannel);
    return { colorChannel, alphaChannel };
}

const materialParams = new MaterialParams();
class MaterialInstance {
    private srt0Animators: BRRES.SRT0TexMtxAnimator[] = [];
    private pat0Animators: BRRES.PAT0TexAnimator[] = [];
    private clr0Animators: BRRES.CLR0ColorAnimator[] = [];
    private materialHelper: GXMaterialHelperGfx;
    public sortKey: number = 0;

    constructor(private modelInstance: MDL0ModelInstance, public materialData: MaterialData) {
        // Create a copy of the GX material, so we can patch in custom channel controls without affecting the original.
        const gxMaterial: GX_Material.GXMaterial = Object.assign({}, materialData.material.gxMaterial);
        gxMaterial.lightChannels = arrayCopy(gxMaterial.lightChannels, lightChannelCopy);

        this.materialHelper = new GXMaterialHelperGfx(gxMaterial, materialData.materialHacks);
        const layer = this.materialData.material.translucent ? GfxRendererLayer.TRANSLUCENT : GfxRendererLayer.OPAQUE;
        this.setSortKeyLayer(layer);
    }

    public setSortKeyLayer(layer: GfxRendererLayer): void {
        if (this.materialData.material.translucent)
            layer |= GfxRendererLayer.TRANSLUCENT;
        this.sortKey = makeSortKey(layer);
    }

    public setVertexColorsEnabled(v: boolean): void {
        this.materialHelper.setVertexColorsEnabled(v);
    }

    public setTexturesEnabled(v: boolean): void {
        this.materialHelper.setTexturesEnabled(v);
    }

    public bindSRT0(animationController: AnimationController, srt0: BRRES.SRT0): void {
        const material = this.materialData.material;
        for (let i: BRRES.TexMtxIndex = 0; i < BRRES.TexMtxIndex.COUNT; i++) {
            const srtAnimator = BRRES.bindSRT0Animator(animationController, srt0, material.name, i);
            if (srtAnimator)
                this.srt0Animators[i] = srtAnimator;
        }
    }

    public bindPAT0(animationController: AnimationController, pat0: BRRES.PAT0): void {
        const material = this.materialData.material;
        for (let i = 0; i < 8; i++) {
            const patAnimator = BRRES.bindPAT0Animator(animationController, pat0, material.name, i);
            if (patAnimator)
                this.pat0Animators[i] = patAnimator;
        }
    }

    public bindCLR0(animationController: AnimationController, clr0: BRRES.CLR0): void {
        const material = this.materialData.material;
        for (let i = 0; i < BRRES.AnimatableColor.COUNT; i++) {
            const clrAnimator = BRRES.bindCLR0Animator(animationController, clr0, material.name, i);
            if (clrAnimator)
                this.clr0Animators[i] = clrAnimator;
        }
    }

    public calcIndTexMatrix(dst: mat4, indIdx: number): void {
        const material = this.materialData.material;
        const texMtxIdx: BRRES.TexMtxIndex = BRRES.TexMtxIndex.IND0 + indIdx;
        if (this.srt0Animators[texMtxIdx]) {
            this.srt0Animators[texMtxIdx].calcIndTexMtx(dst);
            // TODO(jstpierre): What scale is used here?
            dst[12] = 1.0;
        } else {
            const indTexMtx = material.indTexMatrices[indIdx];
            const a = indTexMtx[0], c = indTexMtx[1], tx = indTexMtx[2], scale = indTexMtx[3];
            const b = indTexMtx[4], d = indTexMtx[5], ty = indTexMtx[6];
            mat4.set(dst,
                a,     b,  0, 0,
                c,     d,  0, 0,
                tx,    ty, 0, 0,
                scale, 0,  0, 0,
            );
        }
    }

    public calcTexAnimMatrix(dst: mat4, texIdx: number): void {
        const material = this.materialData.material;
        const texMtxIdx: BRRES.TexMtxIndex = BRRES.TexMtxIndex.TEX0 + texIdx;
        if (this.srt0Animators[texMtxIdx]) {
            this.srt0Animators[texMtxIdx].calcTexMtx(dst);
        } else {
            mat4.copy(dst, material.texSrts[texMtxIdx].srtMtx);
        }
    }

    private calcTexMatrix(materialParams: MaterialParams, texIdx: number, modelMatrix: mat4, camera: Camera): void {
        const material = this.materialData.material;
        const texSrt = material.texSrts[texIdx];
        const flipY = materialParams.m_TextureMapping[texIdx].flipY;
        const flipYScale = flipY ? -1.0 : 1.0;
        const dstPre = materialParams.u_TexMtx[texIdx];
        const dstPost = materialParams.u_PostTexMtx[texIdx];

        // Fast path.
        if (texSrt.mapMode === BRRES.MapMode.TEXCOORD) {
            this.calcTexAnimMatrix(dstPost, texIdx);
            return;
        }

        if (texSrt.mapMode === BRRES.MapMode.PROJECTION) {
            texProjPerspMtx(dstPost, camera.fovY, camera.aspect, 0.5, -0.5 * flipYScale, 0.5, 0.5);

            // Apply effect matrix.
            mat4.mul(dstPost, texSrt.effectMtx, dstPost);

            // XXX(jstpierre): ZSS hack. Reference camera 31 is set up by the game to be an overhead
            // camera for clouds. Kill it until we can emulate the camera system in this game...
            // XXX(jstpierre): Klonoa uses camera 1 for clouds.
            if (texSrt.refCamera === 31 || texSrt.refCamera === 1) {
                dstPost[0] = 0;
                dstPost[5] = 0;
            }
        } else if (texSrt.mapMode === BRRES.MapMode.ENV_CAMERA) {
            texEnvMtx(dstPost, 0.5, -0.5 * flipYScale, 0.5, 0.5);

            // Apply effect matrix.
            mat4.mul(dstPost, texSrt.effectMtx, dstPost);

            // Fill in the dstPre with our normal matrix.
            mat4.mul(dstPre, camera.viewMatrix, modelMatrix);
            computeNormalMatrix(dstPre, dstPre);
        } else {
            mat4.identity(dstPost);
        }

        // Calculate SRT.
        this.calcTexAnimMatrix(matrixScratch, texIdx);

        // SRT matrices have translation in fourth component, but we want our matrix to have translation
        // in third component. Swap.
        mat4SwapTranslationColumns(matrixScratch);

        mat4.mul(dstPost, matrixScratch, dstPost);
    }

    private calcColor(materialParams: MaterialParams, i: ColorKind, fallbackColor: GX_Material.Color, a: BRRES.AnimatableColor): void {
        const dst = materialParams.u_Color[i];
        let color: GX_Material.Color;
        if (this.modelInstance && this.modelInstance.colorOverrides[i]) {
            color = this.modelInstance.colorOverrides[i];
        } else {
            color = fallbackColor;
        }

        if (this.clr0Animators[a]) {
            this.clr0Animators[a].calcColor(dst, color);
        } else {
            colorCopy(dst, color);
        }
    }

    private fillMaterialParamsData(materialParams: MaterialParams, textureHolder: GXTextureHolder, instanceStateData: InstanceStateData, modelMatrix: mat4, camera: Camera): void {
        const material = this.materialData.material;

        for (let i = 0; i < 8; i++) {
            const m = materialParams.m_TextureMapping[i];
            m.reset();

            const sampler = material.samplers[i];
            if (!sampler)
                continue;

            this.fillTextureMapping(m, textureHolder, i);
            // Fill in sampler state.
            m.gfxSampler = this.materialData.gfxSamplers[i];
            m.lodBias = sampler.lodBias;
        }

        for (let i = 0; i < 8; i++)
            this.calcTexMatrix(materialParams, i, modelMatrix, camera);
        for (let i = 0; i < 3; i++)
            this.calcIndTexMatrix(materialParams.u_IndTexMtx[i], i);

        this.calcColor(materialParams, ColorKind.MAT0, material.colorMatRegs[0], BRRES.AnimatableColor.MAT0);
        this.calcColor(materialParams, ColorKind.MAT1, material.colorMatRegs[1], BRRES.AnimatableColor.MAT1);
        this.calcColor(materialParams, ColorKind.AMB0, material.colorAmbRegs[0], BRRES.AnimatableColor.AMB0);
        this.calcColor(materialParams, ColorKind.AMB1, material.colorAmbRegs[1], BRRES.AnimatableColor.AMB1);

        this.calcColor(materialParams, ColorKind.K0, material.colorConstants[0], BRRES.AnimatableColor.K0);
        this.calcColor(materialParams, ColorKind.K1, material.colorConstants[1], BRRES.AnimatableColor.K1);
        this.calcColor(materialParams, ColorKind.K2, material.colorConstants[2], BRRES.AnimatableColor.K2);
        this.calcColor(materialParams, ColorKind.K3, material.colorConstants[3], BRRES.AnimatableColor.K3);

        this.calcColor(materialParams, ColorKind.CPREV, material.colorRegisters[0], -1);
        this.calcColor(materialParams, ColorKind.C0, material.colorRegisters[1], BRRES.AnimatableColor.C0);
        this.calcColor(materialParams, ColorKind.C1, material.colorRegisters[2], BRRES.AnimatableColor.C1);
        this.calcColor(materialParams, ColorKind.C2, material.colorRegisters[3], BRRES.AnimatableColor.C2);

        const lightSetting = instanceStateData.lightSetting;
        if (instanceStateData.lightSetting !== null) {
            const lightSet = lightSetting.lightSet[this.materialData.material.lightSetIdx];
            if (lightSet !== undefined) {
                lightSet.calcLights(materialParams.u_Lights, lightSetting, camera.viewMatrix);
                lightSet.calcAmbColorMult(materialParams.u_Color[ColorKind.AMB0], lightSetting);
                if (lightSet.calcLightSetLitMask(this.materialHelper.material.lightChannels, lightSetting))
                    this.materialHelper.createProgram();
            }
        }
    }

    private fillTextureMapping(dst: TextureMapping, textureHolder: GXTextureHolder, i: number): void {
        const material = this.materialData.material;
        dst.reset();
        if (this.pat0Animators[i]) {
            this.pat0Animators[i].fillTextureMapping(dst, textureHolder);
        } else {
            const name: string = material.samplers[i].name;
            textureHolder.fillTextureMapping(dst, name);
        }
        dst.gfxSampler = this.materialData.gfxSamplers[i];
    }

    public setOnRenderInst(device: GfxDevice, cache: GfxRenderCache, renderInst: GfxRenderInst): void {
        this.materialHelper.setOnRenderInst(device, cache, renderInst);
    }

    public fillMaterialParams(renderInst: GfxRenderInst, textureHolder: GXTextureHolder, instanceStateData: InstanceStateData, modelMatrix: mat4, camera: Camera): void {
        this.fillMaterialParamsData(materialParams, textureHolder, instanceStateData, modelMatrix, camera);

        let offs = renderInst.allocateUniformBuffer(ub_MaterialParams, u_MaterialParamsBufferSize);
        const d = renderInst.mapUniformBufferF32(ub_MaterialParams);
        fillMaterialParamsData(d, offs, materialParams);

        renderInst.setSamplerBindingsFromTextureMappings(materialParams.m_TextureMapping);
    }

    public destroy(device: GfxDevice): void {
        this.materialHelper.destroy(device);
    }
}

class InstanceStateData {
    public matrixVisibility: IntersectionState[] = [];
    public matrixArray: mat4[] = [];
    public lightSetting: BRRES.LightSetting | null = null;
}

const matrixScratchArray = nArray(1, () => mat4.create());
const scratchVec3a = vec3.create();
const scratchVec3b = vec3.create();
export class MDL0ModelInstance {
    public shapeInstances: ShapeInstance[] = [];
    public materialInstances: MaterialInstance[] = [];

    private chr0NodeAnimator: BRRES.CHR0NodesAnimator | null = null;
    private vis0NodeAnimator: BRRES.VIS0NodesAnimator | null = null;
    private instanceStateData = new InstanceStateData();

    private debugBones = false;

    public colorOverrides: GX_Material.Color[] = [];

    public modelMatrix: mat4 = mat4.create();
    public visible: boolean = true;
    public name: string;
    public isSkybox: boolean = false;
    public passMask: number = 1;
    public templateRenderInst: GfxRenderInst;

    constructor(public textureHolder: GXTextureHolder, public mdl0Model: MDL0Model, public namePrefix: string = '') {
        this.name = `${namePrefix}/${mdl0Model.mdl0.name}`;

        this.instanceStateData.matrixArray = nArray(mdl0Model.mdl0.numWorldMtx, () => mat4.create());
        while (matrixScratchArray.length < this.instanceStateData.matrixArray.length)
            matrixScratchArray.push(mat4.create());

        for (let i = 0; i < this.mdl0Model.materialData.length; i++)
            this.materialInstances[i] = new MaterialInstance(this, this.mdl0Model.materialData[i]);
        this.execDrawOpList(this.mdl0Model.mdl0.sceneGraph.drawOpaOps, false);
        this.execDrawOpList(this.mdl0Model.mdl0.sceneGraph.drawXluOps, true);
    }

    public setSortKeyLayer(layer: GfxRendererLayer): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].setSortKeyLayer(layer);
    }

    public setVertexColorsEnabled(v: boolean): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].setVertexColorsEnabled(v);
    }

    public setTexturesEnabled(v: boolean): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].setTexturesEnabled(v);
    }

    public bindCHR0(animationController: AnimationController, chr0: BRRES.CHR0): void {
        this.chr0NodeAnimator = BRRES.bindCHR0Animator(animationController, chr0, this.mdl0Model.mdl0.nodes);
    }

    public bindVIS0(animationController: AnimationController, vis0: BRRES.VIS0): void {
        this.vis0NodeAnimator = BRRES.bindVIS0Animator(animationController, vis0, this.mdl0Model.mdl0.nodes);
    }

    /**
     * Binds {@param srt0} (texture animations) to this model instance.
     *
     * @param animationController An {@link AnimationController} to control the progress of this animation to.
     * By default, this will default to this instance's own {@member animationController}.
     */
    public bindSRT0(animationController: AnimationController, srt0: BRRES.SRT0): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].bindSRT0(animationController, srt0);
    }

    public bindPAT0(animationController: AnimationController, pat0: BRRES.PAT0): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].bindPAT0(animationController, pat0);
    }

    public bindCLR0(animationController: AnimationController, clr0: BRRES.CLR0): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].bindCLR0(animationController, clr0);
    }

    public bindLightSetting(lightSetting: BRRES.LightSetting): void {
        this.instanceStateData.lightSetting = lightSetting;
    }

    /**
     * Binds all animations in {@param rres} that are named {@param name} to this model instance.
     *
     * @param animationController An {@link AnimationController} to control the progress of this animation to.
     * @param rres An {@param RRES} archive with animations to search through.
     * @param name The name of animations to search for. By default, this uses the name of the {@member mdl0Model}
     * used to construct this model instance, as Nintendo appears to use this convention a lot in their games.
     * You can also pass {@constant null} in order to match all animations in the archive.
     */
    public bindRRESAnimations(animationController: AnimationController, rres: BRRES.RRES, name: string | null = this.mdl0Model.mdl0.name): void {
        for (let i = 0; i < rres.chr0.length; i++)
            if (rres.chr0[i].name === name || name === null)
                this.bindCHR0(animationController, rres.chr0[i]);

        for (let i = 0; i < rres.srt0.length; i++)
            if (rres.srt0[i].name === name || name === null)
                this.bindSRT0(animationController, rres.srt0[i]);

        for (let i = 0; i < rres.clr0.length; i++)
            if (rres.clr0[i].name === name || name === null)
                this.bindCLR0(animationController, rres.clr0[i]);

        for (let i = 0; i < rres.pat0.length; i++)
            if (rres.pat0[i].name === name || name === null)
                this.bindPAT0(animationController, rres.pat0[i]);

        for (let i = 0; i < rres.vis0.length; i++)
            if (rres.vis0[i].name === name || name === null)
                this.bindVIS0(animationController, rres.vis0[i]);
    }

    public setColorOverride(i: ColorKind, color: GX_Material.Color): void {
        this.colorOverrides[i] = color;
    }

    public setVisible(visible: boolean): void {
        this.visible = visible;
    }

    private isAnyShapeVisible(): boolean {
        for (let i = 0; i < this.instanceStateData.matrixVisibility.length; i++)
            if (this.instanceStateData.matrixVisibility[i] !== IntersectionState.FULLY_OUTSIDE)
                return true;
        return false;
    }

    public prepareToRender(device: GfxDevice, renderHelper: GXRenderHelperGfx, viewerInput: ViewerRenderInput): void {
        let modelVisibility = this.visible ? IntersectionState.PARTIAL_INTERSECT : IntersectionState.FULLY_OUTSIDE;
        const mdl0 = this.mdl0Model.mdl0;
        const renderInstManager = renderHelper.renderInstManager;
        const camera = viewerInput.camera;

        if (modelVisibility !== IntersectionState.FULLY_OUTSIDE) {
            if (this.isSkybox) {
                modelVisibility = IntersectionState.FULLY_INSIDE;
            } else if (mdl0.bbox !== null) {
                // Frustum cull.
                bboxScratch.transform(mdl0.bbox, this.modelMatrix);
                if (!viewerInput.camera.frustum.contains(bboxScratch))
                    modelVisibility = IntersectionState.FULLY_OUTSIDE;
            }
        }

        if (modelVisibility !== IntersectionState.FULLY_OUTSIDE) {
            if (this.debugBones)
                prepareFrameDebugOverlayCanvas2D();

            this.execNodeTreeOpList(mdl0.sceneGraph.nodeTreeOps, viewerInput, modelVisibility);
            this.execNodeMixOpList(mdl0.sceneGraph.nodeMixOps);

            if (!this.isAnyShapeVisible())
                modelVisibility = IntersectionState.FULLY_OUTSIDE;
        }

        let depth = -1;
        if (modelVisibility !== IntersectionState.FULLY_OUTSIDE) {
            const rootJoint = mdl0.nodes[0];
            if (rootJoint.bbox != null) {
                bboxScratch.transform(rootJoint.bbox, this.modelMatrix);
                depth = Math.max(computeViewSpaceDepthFromWorldSpaceAABB(viewerInput.camera, bboxScratch), 0);
            } else {
                depth = Math.max(depth, 0);
            }
        }

        if (depth < 0)
            return;

        const template = renderInstManager.pushTemplateRenderInst();
        template.filterKey = this.passMask;
        for (let i = 0; i < this.shapeInstances.length; i++) {
            const shapeInstance = this.shapeInstances[i];
            const shapeVisibility = (this.vis0NodeAnimator !== null ? this.vis0NodeAnimator.calcVisibility(shapeInstance.sortVizNode.id) : shapeInstance.sortVizNode.visible);
            if (!shapeVisibility)
                continue;
            shapeInstance.prepareToRender(device, this.textureHolder, renderInstManager, depth, camera, this.modelMatrix, this.instanceStateData, this.isSkybox);
        }
        renderInstManager.popTemplateRenderInst();
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].destroy(device);
    }

    private execDrawOpList(opList: BRRES.DrawOp[], translucent: boolean): void {
        const mdl0 = this.mdl0Model.mdl0;

        for (let i = 0; i < opList.length; i++) {
            const op = opList[i];

            const materialInstance = this.materialInstances[op.matId];

            const node = mdl0.nodes[op.nodeId];
            const shape = this.mdl0Model.mdl0.shapes[op.shpId];
            const shapeData = this.mdl0Model.shapeData[op.shpId];
            const shapeInstance = new ShapeInstance(shape, shapeData, node, materialInstance);
            if (translucent)
                shapeInstance.sortKeyBias = i;

            this.shapeInstances.push(shapeInstance);
        }
    }

    private execNodeTreeOpList(opList: BRRES.NodeTreeOp[], viewerInput: ViewerRenderInput, rootVisibility: IntersectionState): void {
        const mdl0 = this.mdl0Model.mdl0;

        mat4.copy(this.instanceStateData.matrixArray[0], this.modelMatrix);
        this.instanceStateData.matrixVisibility[0] = rootVisibility;

        for (let i = 0; i < opList.length; i++) {
            const op = opList[i];

            if (op.op === BRRES.ByteCodeOp.NODEDESC) {
                const node = mdl0.nodes[op.nodeId];
                const parentMtxId = op.parentMtxId;
                const dstMtxId = node.mtxId;

                let modelMatrix;
                if (this.chr0NodeAnimator !== null && this.chr0NodeAnimator.calcModelMtx(matrixScratch, op.nodeId)) {
                    modelMatrix = matrixScratch;
                } else {
                    modelMatrix = node.modelMatrix;
                }
                mat4.mul(this.instanceStateData.matrixArray[dstMtxId], this.instanceStateData.matrixArray[parentMtxId], modelMatrix);

                if (rootVisibility !== IntersectionState.FULLY_OUTSIDE) {
                    if (rootVisibility === IntersectionState.FULLY_INSIDE || node.bbox === null) {
                        this.instanceStateData.matrixVisibility[dstMtxId] = IntersectionState.FULLY_INSIDE;
                    } else {
                        bboxScratch.transform(node.bbox, this.instanceStateData.matrixArray[dstMtxId]);
                        this.instanceStateData.matrixVisibility[dstMtxId] = viewerInput.camera.frustum.intersect(bboxScratch);
                    }
                } else {
                    this.instanceStateData.matrixVisibility[dstMtxId] = IntersectionState.FULLY_OUTSIDE;
                }

                if (this.debugBones) {
                    const ctx = getDebugOverlayCanvas2D();

                    vec3.set(scratchVec3a, 0, 0, 0);
                    vec3.transformMat4(scratchVec3a, scratchVec3a, this.instanceStateData.matrixArray[parentMtxId]);
                    vec3.set(scratchVec3b, 0, 0, 0);
                    vec3.transformMat4(scratchVec3b, scratchVec3b, this.instanceStateData.matrixArray[dstMtxId]);

                    drawWorldSpaceLine(ctx, viewerInput.camera, scratchVec3a, scratchVec3b);
                }
            } else if (op.op === BRRES.ByteCodeOp.MTXDUP) {
                const srcMtxId = op.fromMtxId;
                const dstMtxId = op.toMtxId;
                mat4.copy(this.instanceStateData.matrixArray[dstMtxId], this.instanceStateData.matrixArray[srcMtxId]);
                this.instanceStateData.matrixVisibility[dstMtxId] = this.instanceStateData.matrixVisibility[srcMtxId];
            }
        }
    }

    private execNodeMixOpList(opList: BRRES.NodeMixOp[]): void {
        for (let i = 0; i < opList.length; i++) {
            const op = opList[i];

            if (op.op === BRRES.ByteCodeOp.NODEMIX) {
                const dst = this.instanceStateData.matrixArray[op.dstMtxId];
                dst.fill(0);

                for (let j = 0; j < op.blendMtxIds.length; j++)
                    mat4.multiplyScalarAndAdd(dst, dst, matrixScratchArray[op.blendMtxIds[j]], op.weights[j]);
            } else if (op.op === BRRES.ByteCodeOp.EVPMTX) {
                const node = this.mdl0Model.mdl0.nodes[op.nodeId];
                mat4.mul(matrixScratchArray[op.mtxId], this.instanceStateData.matrixArray[op.mtxId], node.inverseBindPose);
            }
        }
    }
}

const matrixScratch = mat4.create();
class MaterialData {
    public gfxSamplers: GfxSampler[] = [];

    constructor(device: GfxDevice, public material: BRRES.MDL0_MaterialEntry, public materialHacks?: GX_Material.GXMaterialHacks) {
        for (let i = 0; i < 8; i++) {
            const sampler = this.material.samplers[i];
            if (!sampler)
                continue;

            const [minFilter, mipFilter] = translateTexFilterGfx(sampler.minFilter);
            const [magFilter]            = translateTexFilterGfx(sampler.magFilter);

            // In RRES, the minLOD / maxLOD are in the texture, not the sampler.

            const gfxSampler = device.createSampler({
                wrapS: translateWrapModeGfx(sampler.wrapS),
                wrapT: translateWrapModeGfx(sampler.wrapT),
                minFilter, mipFilter, magFilter,
                minLOD: 0,
                maxLOD: 100,
            });

            this.gfxSamplers[i] = gfxSampler;
        }
    }

    public destroy(device: GfxDevice): void {
        this.gfxSamplers.forEach((r) => device.destroySampler(r));
    }
}
