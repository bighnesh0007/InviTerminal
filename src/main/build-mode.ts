import { app } from 'electron';

/**
 * True for any shipped build. app.isPackaged alone is not enough: the Arch
 * package runs `electron /usr/lib/inviterminal/app.asar` with the system
 * Electron binary, where isPackaged is false. Running from an .asar archive
 * is what every shipped layout has in common; a dev checkout never does.
 */
export function isProductionBuild(dirname: string = __dirname): boolean {
  return app.isPackaged || /\.asar([/\\]|$)/.test(dirname);
}
