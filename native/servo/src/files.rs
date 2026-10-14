//! A private, flat file workspace for one embedded profile.
use crate::{Error, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub const DOWNLOAD_LIMIT: usize = 8 * 1024 * 1024;
pub const UPLOAD_LIMIT: u64 = 64 * 1024 * 1024;
const FILE_LIMIT: usize = 200;

pub struct Files {
    root: PathBuf,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    pub id: String,
    pub path: PathBuf,
    pub bytes: u64,
}
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 180
        || name == "."
        || name == ".."
        || name.starts_with('.')
        || name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
    {
        return Err(invalid(
            "Use a plain filename of 1 to 180 bytes without path separators",
        ));
    }
    Ok(())
}
impl Files {
    pub fn new(root: &Path) -> Result<Self> {
        private_directory(root)?;
        let root = fs::canonicalize(root)?;
        for bucket in ["downloads", "uploads"] {
            private_directory(&root.join(bucket))?;
        }
        Ok(Self { root })
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    fn path(&self, id: &str) -> Result<PathBuf> {
        let (bucket, name) = id
            .split_once('/')
            .ok_or_else(|| invalid("Use a file ID from the workspace listing"))?;
        if !matches!(bucket, "downloads" | "uploads") {
            return Err(invalid("Unknown file folder"));
        }
        validate_name(name)?;
        let directory = self.root.join(bucket);
        if fs::symlink_metadata(&directory)?.file_type().is_symlink() {
            return Err(invalid("File folder must not be a symbolic link"));
        }
        Ok(directory.join(name))
    }
    pub fn existing(&self, id: &str) -> Result<PathBuf> {
        let path = self.path(id)?;
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() {
            return Err(invalid(
                "Select a regular file, not a directory or symbolic link",
            ));
        }
        if metadata.len() > UPLOAD_LIMIT {
            return Err(invalid("File exceeds 64 MiB"));
        }
        Ok(path)
    }
    pub fn list(&self) -> Result<Vec<LocalFile>> {
        let mut files = Vec::new();
        for bucket in ["downloads", "uploads"] {
            // Validate the folder before opening it, including empty folders.
            self.path(&format!("{bucket}/check"))?;
            for entry in fs::read_dir(self.root.join(bucket))?.take(FILE_LIMIT + 1) {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if validate_name(&name).is_err() || !entry.file_type()?.is_file() {
                    continue;
                }
                files.push(LocalFile {
                    id: format!("{bucket}/{name}"),
                    path: entry.path(),
                    bytes: entry.metadata()?.len(),
                });
            }
        }
        files.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(files)
    }
    fn create(&self, id: &str) -> Result<File> {
        let path = self.path(id)?;
        if fs::read_dir(path.parent().unwrap())?
            .take(FILE_LIMIT)
            .count()
            >= FILE_LIMIT
        {
            return Err(invalid(
                "Folder contains 200 files; delete files before adding more",
            ));
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        Ok(options.open(path)?)
    }
    pub fn save_download(&self, name: &str, bytes: &[u8]) -> Result<LocalFile> {
        validate_name(name)?;
        if bytes.len() > DOWNLOAD_LIMIT {
            return Err(invalid("Download exceeds 8 MiB"));
        }
        let id = format!("downloads/{name}");
        let mut file = self.create(&id)?;
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            let _ = fs::remove_file(self.path(&id)?);
            return Err(error.into());
        }
        Ok(LocalFile {
            path: self.path(&id)?,
            id,
            bytes: bytes.len() as u64,
        })
    }
    /// Stage a bounded chunk. Offsets prevent accidental overwrites and interleaving.
    pub fn stage(&self, name: &str, offset: u64, encoded: &str) -> Result<LocalFile> {
        validate_name(name)?;
        if encoded.len() > 44000 {
            return Err(invalid("Stage at most 32 KiB per chunk"));
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| invalid("Invalid base64 file chunk"))?;
        if bytes.len() > 32768 || offset.saturating_add(bytes.len() as u64) > UPLOAD_LIMIT {
            return Err(invalid("File exceeds staging limits"));
        }
        let id = format!("uploads/{name}");
        let mut file = if offset == 0 {
            self.create(&id)?
        } else {
            let mut options = OpenOptions::new();
            options.append(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW);
            }
            options.open(self.existing(&id)?)?
        };
        fs2::FileExt::try_lock_exclusive(&file)?;
        if file.metadata()?.len() != offset {
            return Err(invalid("File offset changed; list files before retrying"));
        }
        if let Err(error) = file.write_all(&bytes) {
            let _ = file.set_len(offset);
            return Err(error.into());
        }
        Ok(LocalFile {
            path: self.path(&id)?,
            id,
            bytes: offset + bytes.len() as u64,
        })
    }
    pub fn read_chunk(&self, id: &str, offset: u64) -> Result<(String, u64)> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(self.existing(id)?)?;
        if offset > file.metadata()?.len() {
            return Err(invalid("Offset exceeds file length"));
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = Vec::new();
        file.take(32768).read_to_end(&mut bytes)?;
        Ok((STANDARD.encode(&bytes), offset + bytes.len() as u64))
    }
    pub fn delete(&self, id: &str) -> Result<()> {
        // Large files can also be removed; size is irrelevant for cleanup.
        let path = self.path(id)?;
        if !fs::symlink_metadata(&path)?.file_type().is_file() {
            return Err(invalid("Only regular workspace files can be deleted"));
        }
        fs::remove_file(path)?;
        Ok(())
    }
}
fn private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(invalid("Workspace folders must not be symbolic links"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stages_lists_and_deletes_without_overwriting() {
        let root = std::env::temp_dir().join(format!("servo-files-{}", uuid::Uuid::new_v4()));
        let files = Files::new(&root).unwrap();
        files.stage("test.txt", 0, "aGk=").unwrap();
        assert!(files.stage("test.txt", 0, "YQ==").is_err());
        assert!(files.stage("test.txt", 1, "YQ==").is_err());
        files.stage("test.txt", 2, "IQ==").unwrap();
        assert_eq!(
            fs::read(files.existing("uploads/test.txt").unwrap()).unwrap(),
            b"hi!"
        );
        files.save_download("saved.txt", b"saved").unwrap();
        assert!(files.save_download("saved.txt", b"replacement").is_err());
        assert_eq!(files.list().unwrap().len(), 2);
        files.delete("downloads/saved.txt").unwrap();
        assert!(files.delete("uploads/../outside").is_err());
        assert!(files.delete("/etc/passwd").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/passwd", root.join("uploads/link")).unwrap();
            assert!(files.existing("uploads/link").is_err());
            assert!(files.delete("uploads/link").is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
