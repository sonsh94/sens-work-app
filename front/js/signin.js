const API_BASE_URL = "http://13.125.122.202:3001";

function parseJwt(token) {
  const base64Url = token.split(".")[1];
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, "=");

  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const json = new TextDecoder("utf-8").decode(bytes);

  return JSON.parse(json);
}

const btnSignIn = document.querySelector("#signin");

btnSignIn.addEventListener("click", signIn);

document.querySelectorAll("#userID, #password").forEach((input) => {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      signIn(event);
    }
  });
});

async function signIn(event) {
  const userID = document.querySelector("#userID").value.trim();
  const password = document.querySelector("#password").value;

  if (!userID || !password) {
    return alert("회원 정보를 입력해주세요.");
  }

  try {
    const signInReturn = await axios({
      method: "post",
      url: `${API_BASE_URL}/sign-in`,
      data: { userID, password },
    });

    const isValidSignIn = signInReturn.data.code === 200;

    if (!isValidSignIn) {
      alert(signInReturn.data.message);
      return;
    }

    const { jwt, mustChangePassword, passwordChangeRecommended } =
      signInReturn.data.result;

    localStorage.setItem("x-access-token", jwt);

    const decodedToken = parseJwt(jwt);
    localStorage.setItem("user-role", decodedToken.role);
    localStorage.setItem("user-nickname", decodedToken.nickname);

    if (mustChangePassword) {
      alert("보안을 위해 최초 로그인 시 비밀번호를 변경해야 합니다.");
      window.location.replace("./change_password.html");
      return;
    }

    if (passwordChangeRecommended) {
      const goChange = confirm(
        "마지막 비밀번호 변경일로부터 3개월이 지났습니다.\n지금 비밀번호를 변경하시겠습니까?"
      );
      if (goChange) {
        window.location.replace("./change_password.html");
        return;
      }
    }

    alert(signInReturn.data.message);
    window.location.replace("./SECM_myself.html");
  } catch (error) {
    if (error.response && error.response.status === 429) {
      alert(error.response.data.message);
    } else if (error.response && error.response.status === 410) {
      alert(error.response.data.message);
    } else {
      console.error("로그인 요청 중 오류 발생:", error);
      alert(error.response?.data?.message || "로그인 요청 중 오류가 발생했습니다.");
    }
  }
}

document.addEventListener("DOMContentLoaded", function () {
  const findIdModal = document.getElementById("find-id-modal");
  const findPasswordModal = document.getElementById("find-password-modal");
  const newPasswordSection = document.getElementById("new-password-section");
  const findPasswordResult = document.getElementById("find-password-result");

  const findIdBtn = document.getElementById("find-id-btn");
  const findPasswordBtn = document.getElementById("find-password-btn");

  document.getElementById("find-id").onclick = function () {
    findIdModal.style.display = "block";
  };

  document.getElementById("find-password").onclick = function () {
    findPasswordModal.style.display = "block";
  };

  document.querySelectorAll(".close").forEach((closeBtn) => {
    closeBtn.onclick = function () {
      findIdModal.style.display = "none";
      findPasswordModal.style.display = "none";
    };
  });

  window.onclick = function (event) {
    if (event.target == findIdModal) {
      findIdModal.style.display = "none";
    }
    if (event.target == findPasswordModal) {
      findPasswordModal.style.display = "none";
    }
  };

  findIdBtn.addEventListener("click", async function () {
    const name = document.getElementById("find-id-name").value.trim();
    const group = document.getElementById("find-id-group").value;
    const site = document.getElementById("find-id-site").value;
    const hireDate = document.getElementById("find-id-hire-date").value;

    try {
      const response = await axios.post(`${API_BASE_URL}/find-id`, {
        name,
        group,
        site,
        hireDate,
      });

      document.getElementById("find-id-result").innerText = response.data.message;
    } catch (error) {
      console.error("아이디 찾기 오류:", error);
      alert(error.response?.data?.message || "아이디 찾기 요청 중 오류가 발생했습니다.");
    }
  });

  findPasswordBtn.addEventListener("click", async function () {
    const userID = document.getElementById("find-password-id").value.trim();
    const name = document.getElementById("find-password-name").value.trim();
    const group = document.getElementById("find-password-group").value;
    const site = document.getElementById("find-password-site").value;
    const hireDate = document.getElementById("find-password-hire-date").value;
    const newPassword = document.getElementById("new-password").value;
    const confirmNewPassword = document.getElementById("confirm-new-password").value;

    if (!newPassword || !confirmNewPassword) {
      findPasswordResult.innerText = "새 비밀번호와 확인 비밀번호를 모두 입력해주세요.";
      return;
    }

    if (newPassword !== confirmNewPassword) {
      findPasswordResult.innerText = "비밀번호가 일치하지 않습니다.";
      return;
    }

    try {
      const response = await axios.post(`${API_BASE_URL}/find-password`, {
        userID,
        name,
        group,
        site,
        hireDate,
        newPassword,
      });

      findPasswordResult.innerText = response.data.message;
      if (response.data.isSuccess) {
        alert("비밀번호가 성공적으로 변경되었습니다.");
        findPasswordModal.style.display = "none";
      }
    } catch (error) {
      console.error("비밀번호 재설정 오류:", error);
      alert(error.response?.data?.message || "비밀번호 재설정 요청 중 오류가 발생했습니다.");
    }
  });

  document
    .querySelectorAll(
      "#find-password-id, #find-password-name, #find-password-group, #find-password-site, #find-password-hire-date"
    )
    .forEach((input) => {
      input.addEventListener("input", function () {
        const userID = document.getElementById("find-password-id").value;
        const name = document.getElementById("find-password-name").value;
        const group = document.getElementById("find-password-group").value;
        const site = document.getElementById("find-password-site").value;
        const hireDate = document.getElementById("find-password-hire-date").value;

        if (userID && name && group && site && hireDate) {
          newPasswordSection.style.display = "block";
          newPasswordSection.style.opacity = 0;
          newPasswordSection.style.transition = "opacity 0.2s ease-in-out";
          setTimeout(() => {
            newPasswordSection.style.opacity = 1;
          }, 10);
        } else {
          newPasswordSection.style.opacity = 0;
          setTimeout(() => {
            newPasswordSection.style.display = "none";
          }, 500);
        }
      });
    });
});
