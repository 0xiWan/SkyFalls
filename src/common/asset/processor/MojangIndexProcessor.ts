import got from 'got'
import { dirname, join } from 'path'
import { ensureDir, pathExists, readFile, readJson, writeFile } from 'fs-extra'

import { Asset } from 'common/asset/model/engine/Asset'
import { AssetGuardError } from 'common/asset/model/engine/AssetGuardError'
import { IndexProcessor } from 'common/asset/model/engine/IndexProcessor'
import { MojangVersionManifest } from 'common/asset/model/mojang/VersionManifest'
import { handleGotError } from 'common/got/RestResponse'
import { AssetIndex, LibraryArtifact, VersionJson } from 'common/asset/model/mojang/VersionJson'
import { calculateHash, getLibraryDir, getVersionJarPath, getVersionJsonPath, validateLocalFile } from 'common/util/FileUtils'
import { getMojangOS, isLibraryCompatible } from 'common/util/MojangUtils'
import { LoggerUtil } from 'common/logging/loggerutil'

export class MojangIndexProcessor extends IndexProcessor {

    public static readonly LAUNCHER_JSON_ENDPOINT = 'https://launchermeta.mojang.com/mc/launcher.json'
    public static readonly VERSION_MANIFEST_ENDPOINT = 'https://launchermeta.mojang.com/mc/game/version_manifest.json'
    public static readonly ASSET_RESOURCE_ENDPOINT = 'http://resources.download.minecraft.net'

    private static readonly logger = LoggerUtil.getLogger('MojangIndexProcessor')

    private versionJson!: VersionJson
    private assetIndex!: AssetIndex
    private client = got.extend({
        responseType: 'json'
    })

    private assetPath: string

    constructor(commonDir: string, protected version: string) {
        super(commonDir)
        this.assetPath = join(commonDir, 'assets')
    }

    /**
     * Download https://launchermeta.mojang.com/mc/game/version_manifest.json
     *   Unable to download:
     *     Proceed, check versions directory for target version
     *       If version.json not present, fatal error.
     *       If version.json present, load and use.
     *   Able to download:
     *     Download, use in memory only.
     *     Locate target version entry.
     *     Extract hash
     *     Validate local exists and matches hash
     *       Condition fails: download
     *         Download fails: fatal error
     *         Download succeeds: Save to disk, continue
     *       Passes: load from file
     * 
     * Version JSON in memory
     *   Extract assetIndex
     *     Check that local exists and hash matches
     *       if false, download
     *         download fails: fatal error
     *       if true: load from disk and use
     * 
     * complete init when 3 files are validated and loaded.
     * 
     */
    public async init(): Promise<void> {

        const versionManifest = await this.loadVersionManifest()
        this.versionJson = await this.loadVersionJson(this.version, versionManifest)
        this.assetIndex = await this.loadAssetIndex(this.versionJson)

    }

    private async loadAssetIndex(versionJson: VersionJson): Promise<AssetIndex> {
        const assetIndexPath = this.getAssetIndexPath(versionJson.assetIndex.id)
        const assetIndex = await this.loadContentWithRemoteFallback<AssetIndex>(versionJson.assetIndex.url, assetIndexPath, { algo: 'sha1', value: versionJson.assetIndex.sha1 })
        if(assetIndex == null) {
            throw new AssetGuardError(`Failed to download ${versionJson.assetIndex.id} asset index.`)
        }
        return assetIndex
    }

    private async loadVersionJson(version: string, versionManifest: MojangVersionManifest | null): Promise<VersionJson> {
        const versionJsonPath = getVersionJsonPath(this.commonDir, version)
        if(versionManifest != null) {
            const versionJsonUrl = this.getVersionJsonUrl(version, versionManifest)
            if(versionJsonUrl == null) {
                throw new AssetGuardError(`Invalid version: ${version}.`)
            }
            const hash = this.getVersionJsonHash(versionJsonUrl)
            if(hash == null) {
                throw new AssetGuardError('Format of Mojang\'s version manifest has changed. Unable to proceed.')
            }
            const versionJson = await this.loadContentWithRemoteFallback<VersionJson>(versionJsonUrl, versionJsonPath, { algo: 'sha1', value: hash })
            if(versionJson == null) {
                throw new AssetGuardError(`Failed to download ${version} json index.`)
            }

            return versionJson
            
        } else {
            // Attempt to find local index.
            if(await pathExists(versionJsonPath)) {
                return await readJson(versionJsonPath)
            } else {
                throw new AssetGuardError(`Unable to load version manifest and ${version} json index does not exist locally.`)
            }
        }
    }

    private async loadContentWithRemoteFallback<T>(url: string, path: string, hash?: {algo: string, value: string}): Promise<T | null> {

        try {
            if(await pathExists(path)) {
                const buf = await readFile(path)
                if(hash) {
                    const bufHash = calculateHash(buf, hash.algo)
                    if(bufHash === hash.value) {
                        return JSON.parse(buf.toString())
                    }
                } else {
                    return JSON.parse(buf.toString())
                }
            }
        } catch(error) {
            throw new AssetGuardError(`Failure while loading ${path}.`, error)
        }
        
        try {
            const res = await this.client.get<T>(url)

            await ensureDir(dirname(path))
            await writeFile(path, res.body)

            return res.body
        } catch(error) {
            return handleGotError(url, error, MojangIndexProcessor.logger, () => null).data
        }

    }

    private async loadVersionManifest(): Promise<MojangVersionManifest | null> {
        try {
            const res = await this.client.get<MojangVersionManifest>(MojangIndexProcessor.VERSION_MANIFEST_ENDPOINT)
            return res.body
        } catch(error) {
            return handleGotError('Load Mojang Version Manifest', error, MojangIndexProcessor.logger, () => null).data
        }
    }

    private getVersionJsonUrl(id: string, manifest: MojangVersionManifest): string | null {
        for(const version of manifest.versions) {
            if(version.id == id){
                return version.url
            }
        }
        return null
    }

    private getVersionJsonHash(url: string): string | null {
        const regex = /^https:\/\/launchermeta.mojang.com\/v1\/packages\/(.+)\/.+.json$/
        const match = regex.exec(url)
        if(match != null && match[1]) {
            return match[1]
        } else {
            return null
        }
    }

    private getAssetIndexPath(id: string): string {
        return join(this.assetPath, 'indexes', `${id}.json`)
    }

    //  TODO progress tracker
    // TODO type return object
    public async validate(): Promise<{[category: string]: Asset[]}> {

        const assets = await this.validateAssets(this.assetIndex)
        const libraries = await this.validateLibraries(this.versionJson)
        const client = await this.validateClient(this.versionJson)
        const logConfig = await this.validateLogConfig(this.versionJson)

        return {
            assets,
            libraries,
            client,
            misc: [
                ...logConfig
            ]
        }
    }

    private async validateAssets(assetIndex: AssetIndex): Promise<Asset[]> {

        const objectDir = join(this.assetPath, 'objects')
        const notValid: Asset[] = []

        for(const assetEntry of Object.entries(assetIndex.objects)) {
            const hash = assetEntry[1].hash
            const path = join(objectDir, hash.substring(0, 2), hash)
            const url = `${MojangIndexProcessor.ASSET_RESOURCE_ENDPOINT}/${hash.substring(0, 2)}/${hash}`

            if(!await validateLocalFile(path, 'sha1', hash)) {
                notValid.push({
                    id: assetEntry[0],
                    hash,
                    size: assetEntry[1].size,
                    url,
                    path
                })
            }
        }

        return notValid

    }

    private async validateLibraries(versionJson: VersionJson): Promise<Asset[]> {
        
        const libDir = getLibraryDir(this.commonDir)
        const notValid: Asset[] = []

        for(const libEntry of versionJson.libraries) {
            if(isLibraryCompatible(libEntry.rules, libEntry.natives)) {
                let artifact: LibraryArtifact
                if(libEntry.natives == null) {
                    artifact = libEntry.downloads.artifact
                } else {
                    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                    // @ts-ignore
                    const classifier = libEntry.natives[getMojangOS()].replace('${arch}', process.arch.replace('x', ''))
                    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                    // @ts-ignore
                    artifact = libEntry.downloads.classifiers[classifier]
                }

                const path = join(libDir, artifact.path)
                const hash = artifact.sha1
                if(!await validateLocalFile(path, 'sha1', hash)) {
                    notValid.push({
                        id: libEntry.name,
                        hash,
                        size: artifact.size,
                        url: artifact.url,
                        path
                    })
                }
            }
        }

        return notValid
    }

    private async validateClient(versionJson: VersionJson): Promise<Asset[]> {

        const version = versionJson.id
        const versionJarPath = getVersionJarPath(this.commonDir, version)
        const hash = versionJson.downloads.client.sha1

        if(!await validateLocalFile(versionJarPath, 'sha1', hash)) {
            return [{
                id: `${version} client`,
                hash,
                size: versionJson.downloads.client.size,
                url: versionJson.downloads.client.url,
                path: versionJarPath
            }]
        }

        return []

    }

    private async validateLogConfig(versionJson: VersionJson): Promise<Asset[]> {

        const logFile = versionJson.logging.client.file
        const path = join(this.assetPath, 'log_configs', logFile.id)
        const hash = logFile.sha1

        if(!await validateLocalFile(path, 'sha1', hash)) {
            return [{
                id: logFile.id,
                hash,
                size: logFile.size,
                url: logFile.url,
                path
            }]
        }

        return []

    }

}