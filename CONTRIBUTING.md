# Workspace Loader

## Devfile for workspace loader development

[devfile.yaml](https://github.com/eclipse/che-workspace-loader/blob/master/devfile.yaml)

## Developer workflow

### Start a workspace from the devfile

There are at least three options how to create and start a workspace from the devfile:

- using [Eclipse Che CLI](https://github.com/che-incubator/chectl) on your own Eclipse Che installation:

    ```bash
    $ chectl workspace:start --devfile=https://raw.githubusercontent.com/eclipse/che-workspace-loader/master/devfile.yaml
    ```

- using factory loading way:

    `https://<CheInstance>/f?url=https://raw.githubusercontent.com/eclipse/che-workspace-loader/master/devfile.yaml`

- in User Dashboard from `Custom Workspace` page.

As the result, Che Theia IDE will be opened and project will be cloned.

### Install dependencies

It's as simple as open `My Workspace` panel in Che Theia IDE and click on `[WS] install dependencies` task to run it. Or, just open terminal in `ws-loader-dev` container, navigate to the project directory and execute `yarn`:

```bash
# [ws-loader-dev container]
$ cd /projects/che-workspace-loader && yarn
```

Once all the dependencies are installed you can make changes or proceed to the next step.

### Build

You may either run task `[WS] run build` from `My Workspace` panel or execute `yarn build` command in project directory:

```bash
# [ws-loader-dev container]
$ cd /projects/che-workspace-loader && yarn build
```

### Run tests

In order to run unit tests you need to find and run task `[WS] run tests` in `My workspace` panel or execute `yarn test` command in project directory:

```bash
# [ws-loader-dev container]
$ yarn test
```

### Start development server

The easiest way to start dev server is to run task `[WS] start dev server` from `My workspace` panel. Under the hood it executes following command in project directory:

```bash
# [ws-loader-dev container]
$ yarn start --disable-host-check --public=$(echo ${server.dev-server} | sed -e s/https:\\/\\/// -e s/http:\\/\\/// -e s/\\///) --host="0.0.0.0" --env.target=${CHE_API_EXTERNAL%????}
```

### Testing new workspace loader

When workspace loader server is run, you probably need to test introduced changes.

To safely test the changes it is better to create a separate workspace which will be used by new loader.
But by default, Che doesn't allow to run more than one workspace simultaneously.
To change this behaviour you need to set `che.limits.user.workspaces.run.count` Che property to value greater than `1`.
In development environment that could be reached by adding `CHE_LIMITS_USER_WORKSPACES_RUN_COUNT` environment variable for Che server config map.
Please note, after changing deployment config you need to apply changes by rolling out (or rescaling) the corresponding pod
(in case of OpenShift just add the environment variable via Openshift dashboard in the `Environment` tab of the Che server deployment and the pod will be rolled out automatically).

To be able to point new workspace loader to the test workspace it is required to add the the test workspace id to the path of workspace loader route.
So, first, we need to retrieve the test workspace id.
This could be done using swagger (please note, it might be disabled on production environment).
To open swagger just open Che dashboard and replace the path with `swagger`.
Then navigate to `workspace` section `GET /workspace` method.
It will return all user workspaces.
Find the test workspace id.
Second, to modify the path of the workspace loader server uri, retrieve the route of the server.
To do it, find workspace loader dev workspace id from the query in swagger above and use it as a key in `GET /workspace/{key}` method.
From the response get the workspace loader server url
(if using the given defile for workspace loader development it should be under `runtime.machines.ws-loader-dev.serevrs.dev-server.url` key).

The URI of workspace loader pointed to the test workspace should look like: `<workspace-loader-route>/<test-workspace-id>`.
For example: `http://server60zomi2d-dev-server-3000.192.168.99.100.nip.io/workspaceztcx9u432labmvxi` or `http://routeu5efcg53-che.apps-crc.testing/workspaceztcx9u432labmvxi` (depending on the infrastructure on which Che is run).

In most cases multiuser Che is deployed.
To permit all the required connections it's needed to edit Keycloak settings.
Open keycloak dashboard (the route could be obtained via Kubernetes or Openshift dashboard) and navigate to `Clients`, select `che-public` and `Settings` tab.
Then add the route with `/*` suffix into `Valid Redirect URIs` section and the original route without trailing slash into `Web Origins` section.
Save changes.

After this opening the obtained URI will open new workspace loader which will start (if not started yet) and open the test workspace.
