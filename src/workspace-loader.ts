/*
 * Copyright (c) 2018-2018 Red Hat, Inc.
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Contributors:
 *   Red Hat, Inc. - initial API and implementation
 */
'use strict';

import { WebsocketClient } from './json-rpc/websocket-client';
import { CheJsonRpcMasterApi } from './json-rpc/che-json-rpc-master-api';
import { Loader } from './loader/loader';
import { che } from '@eclipse-che/api';
import { Deferred } from './json-rpc/util';

// tslint:disable:no-any

const WEBSOCKET_CONTEXT = '/api/websocket';
export const DEBUG_PARAM = 'debug=true';

export class WorkspaceLoader {

    private workspace: che.workspace.Workspace;
    private runtimeIsAccessible: Deferred<void>;

    // `false` if workspace has been stopped intentionally
    // and workspace-loader should not restart it
    private allowRestart: boolean = true;

    constructor(
        private readonly loader: Loader,
        private readonly keycloak?: any
    ) {
        /** Ask dashboard to show the IDE. */
        window.parent.postMessage('show-ide', '*');

        this.runtimeIsAccessible = new Deferred<void>();
    }

    async load(): Promise<void> {
        const workspaceKey = this.getWorkspaceKey();

        if (!workspaceKey || workspaceKey === '') {
            console.error('Workspace is not defined');
            return;
        }

        try {
            this.workspace = await this.getWorkspace(workspaceKey);
            await this.handleWorkspace();
            await this.openIDE();
        } catch (err) {
            if (err) {
                this.loader.error(err);
            } else {
                this.loader.error('Unknown error has happened, try to reload page');
            }
            this.loader.hideLoader();
            this.loader.showReload();
        }
    }

    /**
     * Returns workspace key from current location or empty string when it is undefined.
     */
    getWorkspaceKey(): string {
        const result: string = window.location.pathname.substr(1);
        return result.substr(result.indexOf('/') + 1, result.length);
    }

    /**
     * Returns base websocket URL.
     */
    websocketBaseURL(): string {
        const wsProtocol = 'http:' === document.location!.protocol ? 'ws' : 'wss';
        return wsProtocol + '://' + document.location!.host;
    }

    /**
     * Returns query string.
     */
    getQueryString(): string {
        return location.search;
    }

    /**
     * Get workspace by ID.
     *
     * @param workspaceId workspace id
     */
    async getWorkspace(workspaceId: string): Promise<che.workspace.Workspace> {
        const request = new XMLHttpRequest();
        request.open('GET', '/api/workspace/' + workspaceId);
        const requestWithAuth = await this.setAuthorizationHeader(request);
        return new Promise<che.workspace.Workspace>((resolve, reject) => {
            requestWithAuth.send();
            requestWithAuth.onreadystatechange = () => {
                if (requestWithAuth.readyState !== 4) {
                    return;
                }
                if (requestWithAuth.status !== 200) {
                    reject(new Error(`Failed to get the workspace: "${this.getRequestErrorMessage(requestWithAuth)}"`));
                    return;
                }
                resolve(JSON.parse(requestWithAuth.responseText));
            };
        });
    }

    /**
     * Start current workspace.
     */
    async startWorkspace(): Promise<che.workspace.Workspace> {
        const isDebugMode = this.getQueryString().includes(DEBUG_PARAM);
        const request = new XMLHttpRequest();
        request.open('POST', `/api/workspace/${this.workspace.id}/runtime${isDebugMode ? '?debug-workspace-start=true' : ''}`);
        const requestWithAuth = await this.setAuthorizationHeader(request);
        return new Promise<che.workspace.Workspace>((resolve, reject) => {
            requestWithAuth.send();
            requestWithAuth.onreadystatechange = () => {
                if (requestWithAuth.readyState !== 4) {
                    return;
                }
                if (requestWithAuth.status !== 200) {
                    reject(new Error(`Failed to start the workspace: "${this.getRequestErrorMessage(requestWithAuth)}"`));
                    return;
                }
                resolve(JSON.parse(requestWithAuth.responseText));
                resolve(JSON.parse(requestWithAuth.responseText));
            };
        });
    }

    private getRequestErrorMessage(xhr: XMLHttpRequest): string {
        let errorMessage: string | undefined;
        try {
            const response = JSON.parse(xhr.responseText);
            errorMessage = response.message;
        } catch (e) { }

        if (errorMessage) {
            return errorMessage;
        }

        if (xhr.statusText) {
            return xhr.statusText;
        }

        return 'Unknown error';
    }

    /**
     * Handles workspace status.
     */
    private async handleWorkspace(): Promise<void> {
        if (this.workspace.status === 'RUNNING') {
            return await this.checkWorkspaceRuntime();
        }

        const masterApi = await this.connectMasterApi();
        this.subscribeWorkspaceEvents(masterApi);
        masterApi.addListener('open', async () => {
            try {
                await this.checkWorkspaceRuntime();
                this.runtimeIsAccessible.resolve();
            } catch (e) { }
        });

        if (this.workspace.status === 'STOPPED') {
            try {
                await this.startWorkspace();
            } catch (e) {
                this.runtimeIsAccessible.reject(e);
            }
        }

        return this.runtimeIsAccessible.promise;
    }

    /**
     * Shows environment and installer outputs.
     *
     * @param message
     */
    private onLogOutput(message: che.workspace.event.RuntimeLogEvent): void {
        if (message.text) {
            this.loader.log(message.text);
        }
    }

    /**
     * Resolves deferred when workspace is running and runtime is accessible.
     *
     * @param message
     */
    private async onWorkspaceStatus(message: che.workspace.event.WorkspaceStatusEvent): Promise<void> {
        if (message.error) {
            this.runtimeIsAccessible.reject(new Error(`Failed to run the workspace: "${message.error}"`));
            return;
        }

        if (message.status === 'RUNNING') {
            try {
                await this.checkWorkspaceRuntime();
                this.runtimeIsAccessible.resolve();
            } catch (e) {
                this.runtimeIsAccessible.reject(e);
            }
            return;
        }

        if (message.status === 'STOPPING') {
            if (message.prevStatus === 'STARTING') {
                this.allowRestart = false;
            }
        }

        if (message.status === 'STOPPED') {
            if (message.prevStatus === 'STARTING') {
                this.loader.error('Workspace stopped.');
                this.runtimeIsAccessible.reject('Workspace stopped.');
            }
            if (message.prevStatus === 'STOPPING' && this.allowRestart) {
                try {
                    await this.startWorkspace();
                } catch (e) {
                    this.runtimeIsAccessible.reject(e);
                }
            }
            this.allowRestart = true;
        }
    }

    private async connectMasterApi(): Promise<CheJsonRpcMasterApi> {
        const entryPoint = this.websocketBaseURL() + WEBSOCKET_CONTEXT;
        const master = new CheJsonRpcMasterApi(new WebsocketClient(), entryPoint, this);
        await master.connect();
        return master;
    }

    /**
     * Subscribes to the workspace events.
     */
    private subscribeWorkspaceEvents(masterApi: CheJsonRpcMasterApi): void {
        masterApi.subscribeEnvironmentOutput(
            this.workspace.id!,
            (message: che.workspace.event.RuntimeLogEvent) => this.onLogOutput(message)
        );
        masterApi.subscribeWorkspaceStatus(
            this.workspace.id!,
            (message: che.workspace.event.WorkspaceStatusEvent) => this.onWorkspaceStatus(message)
        );
    }

    private async checkWorkspaceRuntime(): Promise<void> {
        const workspace = await this.getWorkspace(this.workspace.id!);

        if (workspace.status !== 'RUNNING') {
            throw new Error('Workspace is NOT RUNNING yet.');
        }
        if (!workspace.runtime) {
            throw new Error('You do not have permissions to access workspace runtime, in this case IDE cannot be loaded.');
        }
    }

    /**
     * Opens IDE for the workspace.
     */
    async openIDE(): Promise<void> {
        const workspace = await this.getWorkspace(this.workspace.id!);
        if (!workspace.runtime) {
            throw new Error('Running workspace is expected to be able to open an IDE');
        }
        const machines = workspace.runtime.machines || {};
        for (const machineName of Object.keys(machines)) {
            const servers = machines[machineName].servers || {};
            for (const serverId of Object.keys(servers)) {
                const attributes = servers[serverId].attributes;
                if (attributes && attributes['type'] === 'ide') {
                    this.openURL(servers[serverId].url + this.getQueryString());
                    return;
                }
            }
        }

        if (workspace.links) {
            this.openURL(workspace.links.ide + this.getQueryString());
        }

        throw new Error('Don\'t know what to open, IDE url is not defined.');
    }

    /**
     * Schedule opening URL.
     * Scheduling prevents appearing an error net::ERR_CONNECTION_REFUSED instead opening the URL.
     *
     * @param url url to be opened
     */
    openURL(url: string): void {
        // Preconfigured IDE may use dedicated port. In this case Chrome browser fails
        // with error net::ERR_CONNECTION_REFUSED. Timer helps to open the URL without errors.
        setTimeout(() => {
            window.location.href = url;
        }, 100);
    }

    async setAuthorizationHeader(xhr: XMLHttpRequest): Promise<XMLHttpRequest> {
        return new Promise((resolve, reject) => {
            if (this.keycloak && this.keycloak.token) {
                this.keycloak.updateToken(5).success(() => {
                    xhr.setRequestHeader('Authorization', 'Bearer ' + this.keycloak.token);
                    resolve(xhr);
                }).error(() => {
                    window.sessionStorage.setItem('oidcIdeRedirectUrl', location.href);
                    this.keycloak.login();
                    reject(new Error('Failed to refresh token'));
                });
                return;
            }

            resolve(xhr);
        });
    }

    async getAuthenticationToken(): Promise<string> {
        if (!this.keycloak) {
            return Promise.resolve('');
        }
        return new Promise(resolve => {
            this.keycloak.updateToken(5).success(() => {
                resolve('?token=' + this.keycloak.token);
            }).error(() => {
                resolve('');
            });
        });
    }

}
