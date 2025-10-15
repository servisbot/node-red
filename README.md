# ServisBOT Node Red

To make a change to the node-red runtime being used by K4 avalanche:
1. Checkout from this branch `servisbot-branch`
2. Make changes
3. PR into this branch
4. Merge on approval
5. Manually bump the package version
6. Run `npm run build` - note you need to run node 10 to do this, you also need to have xcode installed
7. Manually publish to NPM with `npm publish` - Request creds from ops for this


# Dev Work
If you're using an Apple Silicon MacBook, to run and build it you need to prefix all npm commands with `arch -x86_64` because this project uses Node v10, which isn't supported natively on those devices.

When working with k4, you can do the following to test your changes as you work:

In your local node-red project, perform the following:

- `arch -x86_64 npm run build`
- `npm pack` - this generates a `tgz` file

In your local copy of k4avalanche reference this file in your `package.json`:

- `"@servisbot/node-red": "file:../node-red/servisbot-node-red-0.18.7-patch-15.tgz"`
- `npm install`

Now when you start k4, it will include your local copy of node-red.

# CHANGE-LOG

## 0.18.7-patch-15
2024-01-11
- Added ability for the function node to process codefile results

## 0.18.7-patch-14
2023-11-14
- Log fix to no longer be stringified

## 0.18.7-patch-13
2023-11-13
- Small fix for codefile logic

## 0.18.7-patch-12
2023-11-09
- Added code file as an alternative to vm for function nodes

## 0.18.7-patch-11
2023-02-14
- Added ability to do loop detection

## 0.18.7-patch-10.3
2023-01-03
- Removed subflow ID auto-generation, now prefixes the nodeId with the subflow id

## 0.18.7-patch-10
2021-07-14
- Updated logic to swap back org to correct value when possible
  
## 0.18.7-patch-9.1
2021-07-09
- Bug fix for when retuning a array out of a function node


## 0.18.7-patch-8 
2021-07-08
- Added support to log out when organization variable was changed within function or change node