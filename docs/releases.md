# Docker Hub releases

The GitHub Actions workflow in `.github/workflows/docker-publish.yml` publishes `syntropika/remote-browser` to Docker Hub whenever a Git tag is pushed to GitHub. The workflow must be present in the tagged commit.

Configure the repository's Actions secret `DOCKER_TOKEN` with a Docker Hub access token for `syntropika` that has write access to `syntropika/remote-browser`. The token is used only by the registry login step; it is not passed to the Docker build.

The workflow installs the locked dependencies, checks TypeScript and runs the unit and gateway tests before building and publishing the production Dockerfile. The Dockerfile also checks and compiles TypeScript. Buildx builds `linux/amd64` and `linux/arm64` images and publishes both under one multi-platform tag, using QEMU to build ARM64 on the amd64 runner. Docker selects the matching architecture when pulling that tag. BuildKit uses the GitHub Actions cache, and published images carry source and revision labels.

The existing `v0.1.0` image supports only `linux/amd64`. Multi-platform images require a new tag pointing to a commit with the updated workflow; do not move or overwrite an existing release tag. Building an ARM64 image does not verify Chromium's sandbox or browser behavior on a native ARM64 host. Only x86-64 runtime behavior is currently tested.

Each image uses the Git tag, including a leading `v`, and also receives the `latest` tag. For example, pushing `v1.0.0` publishes the same multi-platform image as both `syntropika/remote-browser:v1.0.0` and `syntropika/remote-browser:latest`. Docker Metadata sanitizes characters that Docker tags do not allow. Every successful tag build updates `latest`, including prereleases and older versions published afterward. The first tag published with this workflow creates `latest`; pushes to `main` alone do not publish images.

Once the workflow is committed and pushed to the repository, publish a release with:

```sh
git tag v1.0.0
git push origin v1.0.0
```

Pull the published image with:

```sh
docker pull syntropika/remote-browser:v1.0.0
```

To follow subsequent releases without changing the configured version, use:

```sh
docker pull syntropika/remote-browser:latest
```

Publishing an image does not automatically update a running container. Pull the image and recreate the container to apply an update, preserving its data volume.
