
// Elebits

import * as Viewer from '../viewer';
import * as UI from '../ui';
import * as BRRES from './brres';

import { leftPad } from '../util';
import { fetchData } from '../fetch';
import Progressable from '../Progressable';
import ArrayBufferSlice from '../ArrayBufferSlice';
import { GfxDevice, GfxHostAccessPass } from '../gfx/platform/GfxPlatform';
import { MDL0ModelInstance, MDL0Model, RRESTextureHolder } from './render';
import { BasicGXRendererHelper } from '../gx/gx_render_2';
import AnimationController from '../AnimationController';
import { GXMaterialHacks } from '../gx/gx_material';

function makeElbPath(stg: string, room: number): string {
    let z = leftPad(''+room, 2);
    return `elb/${stg}_${z}_disp01.brres`;
}

const materialHacks: GXMaterialHacks = {
    lightingFudge: (p) => `${p.matSource} + 0.2`,
};

class ElebitsRenderer extends BasicGXRendererHelper {
    private modelInstances: MDL0ModelInstance[] = [];
    private models: MDL0Model[] = [];

    private animationController: AnimationController;

    constructor(device: GfxDevice, public stageRRESes: BRRES.RRES[], public textureHolder = new RRESTextureHolder()) {
        super(device);

        this.animationController = new AnimationController();

        for (let i = 0; i < stageRRESes.length; i++) {
            const stageRRES = stageRRESes[i];
            this.textureHolder.addRRESTextures(device, stageRRES);
            if (stageRRES.mdl0.length < 1)
                continue;

            const model = new MDL0Model(device, this.getCache(), stageRRES.mdl0[0], materialHacks);
            this.models.push(model);
            const modelRenderer = new MDL0ModelInstance(this.textureHolder, model);
            this.modelInstances.push(modelRenderer);

            modelRenderer.bindRRESAnimations(this.animationController, stageRRES);
        }
    }

    public createPanels(): UI.Panel[] {
        const panels: UI.Panel[] = [];

        if (this.modelInstances.length > 1) {
            const layersPanel = new UI.LayerPanel();
            layersPanel.setLayers(this.modelInstances);
            panels.push(layersPanel);
        }

        return panels;
    }

    protected prepareToRender(device: GfxDevice, hostAccessPass: GfxHostAccessPass, viewerInput: Viewer.ViewerRenderInput): void {
        const template = this.renderHelper.pushTemplateRenderInst();
        this.renderHelper.fillSceneParams(viewerInput, template);
        for (let i = 0; i < this.modelInstances.length; i++)
            this.modelInstances[i].prepareToRender(device, this.renderHelper, viewerInput);
        this.renderHelper.prepareToRender(device, hostAccessPass);
        this.renderHelper.renderInstManager.popTemplateRenderInst();
    }

    public destroy(device: GfxDevice): void {
        super.destroy(device);

        this.textureHolder.destroy(device);
        this.renderHelper.destroy(device);

        for (let i = 0; i < this.models.length; i++)
            this.models[i].destroy(device);
        for (let i = 0; i < this.modelInstances.length; i++)
            this.modelInstances[i].destroy(device);
    }
}

class ElebitsSceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string, public rooms: number[]) {}

    public createScene(device: GfxDevice, abortSignal: AbortSignal): Progressable<Viewer.SceneGfx> {
        const paths = this.rooms.map((room) => makeElbPath(this.id, room));
        const progressables: Progressable<ArrayBufferSlice>[] = paths.map((path) => fetchData(path, abortSignal));
        return Progressable.all(progressables).then((buffers: ArrayBufferSlice[]) => {
            const stageRRESes = buffers.map((buffer) => BRRES.parse(buffer));
            return new ElebitsRenderer(device, stageRRESes);
        });
    }
}

function range(start: number, count: number): number[] {
    const L: number[] = [];
    for (let i = start; i < start + count; i++)
        L.push(i);
    return L;
}

const id = "elb";
const name = "Elebits";
const sceneDescs: Viewer.SceneDesc[] = [
    new ElebitsSceneDesc("stg01", "Mom and Dad's House", range(1, 18)),
    new ElebitsSceneDesc("stg03", "The Town", [1]),
    new ElebitsSceneDesc("stg02", "Amusement Park - Main Hub", [1, 5]),
    new ElebitsSceneDesc("stg02", "Amusement Park - Castle", [2]),
    new ElebitsSceneDesc("stg02", "Amusement Park - Entrance", [3, 6]),
    new ElebitsSceneDesc("stg02", "Amusement Park - Space", [4]),
    new ElebitsSceneDesc("stg04", "Tutorial", [1, 2]),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
