{
  description = "cfn-event-tailer";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };
  outputs =
    inputs@{ self, flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      perSystem =
        { self', pkgs, ... }:
        let
          buildNpmPackage = pkgs.buildNpmPackage.override { nodejs = pkgs.nodejs_24; };
        in
        {
          packages = {
            cfn-event-tailer = buildNpmPackage {
              pname = "cfn-event-tailer";
              version = toString (self.shortRev or self.dirtyShortRev or self.lastModified or "unknown");
              src = ./.;
              npmDepsHash = "sha256-xSbN3+3MPz00fXw0WA2EC77q7oC2xjFcNu0uVPDsTwg=";
              dontNpmBuild = true;
              meta.mainProgram = "cfn-event-tailer";
            };
            default = self'.packages.cfn-event-tailer;
          };

          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.awscli2
              pkgs.nodejs_24
            ];
            inputsFrom = [ self'.packages.default ];
          };
        };
      systems = inputs.nixpkgs.lib.systems.flakeExposed;
    };
}
