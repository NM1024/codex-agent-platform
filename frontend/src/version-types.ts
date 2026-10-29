export interface RunningVersion {current:string}
export interface LatestVersion extends RunningVersion {latest:string;update_available:boolean;release_url:string;checked_at:number}
export interface UpgradeJob {
  id:string;state:'queued'|'running'|'succeeded'|'failed'|'interrupted';phase:string;
  started_at:number;updated_at:number;target_version?:string;installed_version?:string;error_code?:string;
}
export interface UpgradeStatus {available:boolean;job:UpgradeJob|null;error_code?:string}
export const activeUpgrade=(job:UpgradeJob|null|undefined)=>job?.state==='queued'||job?.state==='running';

export type VersionUi=Pick<typeof import('antd'),'Alert'|'Button'|'Modal'|'Typography'>;
export interface VersionContext {ui:VersionUi;api:<T>(path:string,body?:unknown)=>Promise<T>;locale:string}
