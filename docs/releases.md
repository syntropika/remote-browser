# Docker Hub releases

The GitHub Actions workflow in `.github/workflows/docker-publish.yml` publishes `syntropika/remote-browser` to Docker Hub whenever a Git tag is pushed to GitHub. The workflow must be present in the tagged commit.

Configure the repository's Actions secret `DOCKER_TOKEN` with a Docker Hub access token for `syntropika` that has write access to `syntropika/remote-browser`. The token is used only by the registry login step; it is not passed to the Docker build.

The workflow installs the locked dependencies, checks TypeScript and runs the unit and gateway tests before building and publishing the production Dockerfile. The Dockerfile also checks and compiles TypeScript. Published images target `linux/amd64`. BuildKit uses the GitHub Actions cache, and published images carry source and revision labels.

Each image uses the Git tag, including a leading `v`. For example, pushing `v1.0.0` publishes `syntropika/remote-browser:v1.0.0`. Docker Metadata sanitizes characters that Docker tags do not allow. No `latest` or version aliases are published, so prereleases and older releases do not change a shared release tag.

Once the workflow is committed and pushed to the repository, publish a release with:

```sh
git tag v1.0.0
git push origin v1.0.0
```

Pull the published image with:

```sh
docker pull syntropika/remote-browser:v1.0.0
```

Publishing an image does not automatically update a running container.
